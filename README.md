# PingRoom expense settlement

Ask each named person whether they shared each expense, then propose reimbursements
from their answers. PingRoom collects attributed **Shared**, **Did not share**, or
**Unknown** responses. Code splits integer minor units, calculates paid-minus-owed
balances, and nets those balances into a local transfer proposal.

The starter makes no payments and does not verify receipts or determine whether
an expense is legitimate.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux with private persistent storage.
Choose **Use this template**, clone your repository, and run:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real SDK with an in-memory HTTP transport. It needs no
credentials, makes no network requests, and removes its temporary state. One run
settles shared workshop supplies and transport; another shows Unknown blocking
the proposal. Installing dependencies requires npm access.

## Prepare and connect

```sh
cp examples/expenses.json expenses.json
npm run preview
npm run connect
npm run inspect
```

Edit `expenses.json` before collecting answers:

- `settlementId`: a unique ID for this fixed set of expenses.
- `title`: context people will recognize in their Questions.
- `currency` and `minorUnitDigits`: the operator-declared currency label and scale.
  For example, `USD` with `2` means `1001` minor units displays as `USD 10.01`.
- `participants`: 2–6 people, each with an exact PingRoom member UUID and label.
- `receipts`: 1–6 records, each with an ID, label, payer UUID, and positive integer
  `amountMinor`. The payer must be a named participant.

Every participant answers every receipt; the product of those counts must be at
most 24. `preview` validates input and prints that question list without credentials
or network calls. Receipt records are supplied by your workflow; no image parsing,
receipt upload, amount inference, or currency conversion occurs.

The currency check accepts three uppercase letters, and the scale accepts 0–3
decimal places. These are syntax checks, **not verified currency metadata**. Confirm
both values yourself. All receipts must already use that single currency and scale.

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and choose a
**standard private room** containing every participant. PingRoom defines the
capability grant for new connections (`pingroom:full`); you choose which rooms
the connection may access. Asking another participant requires the connecting
account to be the room owner or an admin, or the room to allow everyone to trigger.
Normal permissions and quotas apply. The connecting account may be a participant.

`inspect` lists member UUIDs and lookup names. Verify each person in the app and
replace the example UUIDs in `expenses.json`; names alone do not establish identity.
Labels and expense details are included in Questions, so use an appropriate room.

Pairing saves private `.pingroom/credentials.json` and reuses its pending link.
An existing connection is never overwritten. If pairing creation is uncertain or
the link expires, inspect Connected Agents and resolve or revoke the old robot
before archiving `.pingroom/pairing.json` for new setup. Keep uncertain
intent while investigating.

Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank
pairs fail. Defining either shell variable selects the entire shell pair, without
borrowing values from `.env`. Paths resolve from the project directory.

## Collect and export

```sh
npm start          # Ask the next person/receipt, or read its Question once.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read saved evidence offline.
npm run report     # Also write private .settlement/report.json.
```

Questions are asked by ascending receipt ID, then ascending lowercase participant
UUID. Each invocation creates or reads at most one Question. Only one is active
at a time, with a 15-minute lifetime. Serialize calls from your existing runner;
this starter installs no scheduler.

**Shared** includes the respondent in that receipt's equal split. **Did not share**
excludes them. The payer answers too: paying does not imply benefiting. **Unknown**
means participation remains unresolved. A receipt must have at least one beneficiary.

Unknown, unasked, pending, expired, cancelled, invalid, and uncertain outcomes
remain distinct. Other questions can still be collected after a terminal outcome,
but `settlement` stays `null` until every answer is known and each receipt has a
beneficiary. No missing answer becomes participation or exclusion. Terminal requests
are not reissued within the session.

The report retains Question IDs, respondent UUIDs, asking registration, and answer
and observation times. `participation` contains the evidence; an answered Unknown
has `shared: null`. Once all answers are known, `noBeneficiaryReceiptIds` identifies
receipts that nobody shared. Complete evidence replays locally without checking
current room access or claiming the answers remain current.

A complete `settlement` contains integer `allocations`, `balances`, and proposed
`transfers`. `amountMinor`, `paidMinor`, `owedMinor`, and `netMinor` are authoritative;
formatted `amount` and `net` strings use the declared scale for display. Positive
net balance means the person should receive funds; negative means they owe funds.

## Splitting and netting rules

Each receipt is split independently. Code divides its minor-unit amount by the
number of Shared respondents, rounds each share down to an integer, then assigns
one extra minor unit to the first remaining respondents in ascending lowercase
UUID order. This tie-break is deterministic and is not a statement of fairness.
For 1,001 units shared by three people, their shares are 334, 334, and 333.

Code sums each person's payments and allocated shares, then calculates
`netMinor = paidMinor - owedMinor`. Debtors and creditors are each sorted by UUID.
For each debtor, the proposal allocates payment to the first remaining creditor
up to the smaller outstanding amount, continuing until all balances clear.
The result conserves every minor unit and has no self-transfers or zero-value
transfers. This deterministic procedure does
not guarantee the globally smallest possible number of transfers.

In the demo, Alex pays 1,001 units for supplies shared by all three people. Blair
pays 500 units for transport shared by Alex and Casey. Casey's proposed transfers
are 417 units to Alex and 166 to Blair. Blair is reimbursed even though Blair did
not share transport. Review the input and proposal with participants before using
another system to act on it.

Exit codes for `start`/`recover`: `0` complete proposal; `2` incomplete settlement
or newly observed expired/cancelled/invalid answer; `3` ready/pending/interrupted;
`4` uncertain creation; `1` errors. Unknown may leave `ready` while others remain;
the final incomplete result exits `2`. Local report commands exit `0` when readable,
so inspect their JSON status.

## Resume and recover

The journal binds the exact input, room, and credential fingerprint. Inputs are
immutable throughout a session, including array order and labels. A standalone
calculation is invariant to array ordering; an existing session still refuses
reordered input because it preserves the exact evidence context.

Before any question POST, the journal saves and syncs its full request, 900-second
TTL, correlation, and idempotency key. A crash, lost or malformed response, or
failed save can leave `create_unknown`. Later runs neither repeat that POST nor
ask the next participant until recovery:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads up to 200 recent Questions and prints matching `candidates`. No
match does not prove creation failed. Use the originating robot's history or saved
response to find the original ID when needed. Recovery reads that exact ID and
checks the full request, room, target, asking registration, and lifetime before
attaching it. It sends no new Question. Reads require the original registration;
reconnecting does not recover inaccessible Questions.

Answers must come from the targeted server-authenticated responder with an exact
option. Answer and resolution timestamps must agree and fall within the lifetime.
Expiry may be processed after its deadline. Future timestamps allow at most
60 seconds of local clock skew; observations cannot move backwards.

Resolve active or uncertain work before archiving the whole private `.settlement/`
directory to start revised input with a new settlement ID. Preserve old evidence.
Deleting state or using another checkout can create duplicates. There is no
automatic state migration or distributed exactly-once guarantee.

## Adapt and verify

`src/engine.js` exports `step` for existing workflow runners. `src/model.js` owns
input validation, attribution, equal splitting, and transfer proposals. Keep those
rules in application code; no AI service is required. Input text is never executed
as commands or fetched as URLs. The saved journal is local evidence, not a signed
or tamper-proof accounting ledger; protect it and its backups.

Settlement IDs allow 40 characters and receipt IDs 24, starting with a lowercase
letter and using lowercase letters, digits, `_`, or `-`. Titles allow 60 printable
ASCII characters, person labels 40, and receipt labels 80, without outer spaces.
Each receipt permits 1–1,000,000,000 integer minor units; the largest supported total
is 6,000,000,000. All calculations stay within exact JavaScript integer bounds.

Input files are capped at 16 KiB, state/reports at 1 MiB, and HTTP bodies at 512 KiB.
Writes use a private temporary file, file sync, rename, and directory sync. One
process owns each directory's lock. After a crash, inspect `.settlement/.lock/owner.json`
or `.pingroom/.lock/owner.json`, confirm that process stopped, then remove only the
stale lock. Restore corrupt state from a valid private backup.

Credentials, local inputs, state, and reports are ignored by Git. Files use `0600`
and directories `0700` on POSIX. The [official SDK](https://github.com/pingroom/sdk)
is pinned to `0.7.0` with a lockfile and 14-day minimum release age. Requests use
the official API origin, refuse redirects, and have a five-second deadline through
body consumption. Tests include an independent unit-allocation oracle, rounding,
conservation, attribution, uncertain creation, exact-ID recovery, and actual CLI
exit codes. CI runs on Node 22 and 24 using mocks; live phone delivery is not tested.

Unlike [human review](https://github.com/pingroom/starter-human-review), these
answers establish each person's participation in a cost split; they authorize no
external action. Unlike [shift assignment](https://github.com/pingroom/starter-shift-assignment),
this workflow conserves monetary units across debtors and creditors rather than
assigning people to capacity slots.

MIT licensed; see [LICENSE](LICENSE).
