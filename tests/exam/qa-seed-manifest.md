# QA seed manifest — the demo hotels' renamed rows

The demo/test hotels are shown to investors. On 2026-07-26 the visible
`[QA seed]` prefixes were stripped off every manager-facing name on them, so the
screens read like a real hotel's. This file is the record of what was renamed,
because for some of those rows the prefix **was** the only thing marking them as
test data.

## How to tell seed data apart now

In order of durability:

1. **`properties.is_test = true`.** Every property-scoped row below hangs off one
   of exactly three hotels, and all three are flagged. This is the real tag; the
   string prefix always was belt-and-braces.

   | property | id |
   |---|---|
   | Test Hotel | `c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f` |
   | Testing Hotel | `96a26a7f-7129-47db-8855-b7b34407b843` |
   | Port Arthur Inn | `cc000003-0000-4000-8000-000000000003` |

   The two seeded organizations are `11110000-0000-4000-8000-0000000000a1`
   (Gulf Coast Hotels) and `0cb05fe5-f256-453e-b8a5-b3805ac3142f` (Port Arthur
   Inn's own org). The six demo people are the `accounts` whose `username`
   starts `qa.` — that column was never rendered and was not touched.

2. **Markers deliberately left in place** in fields nothing renders:

   | table.column | rows | why it stayed |
   |---|---|---|
   | `preventive_tasks.notes` | 5 | only reachable inside the edit sheet, never on a card |
   | `findings.evidence → params.qa_seed` | 7 | a dedicated tag key; `params` are substitution slots and there is no `{qa_seed}` slot |
   | `finding_actions.params` / `.verify` | 5 + 5 | frozen at proposal time and **immutable in Postgres** (0363 `staxis_finding_actions_frozen_tg`) — an UPDATE is refused by design |
   | `inventory_audit_events.summary` / `.details` / `.before_state` / `.after_state` | 135 / 131 / 4 / 135 | the money ledger is **immutable** (`inventory_audit_events_immutable`) |
   | `inventory_orders.notes` | 131 | free-text reference, not rendered |
   | `agent_messages.tool_args` / `.tool_result` | 3 / 6 | machine payloads behind the chat, not rendered |
   | `organization_access_events.before_state` / `.after_state` | 2 / 2 | an audit trail of what the names *were*; rewriting it would be the lie it exists to prevent |
   | `idempotency_log.response` | 1 | machine |

3. **This file**, for the rows where the visible name was the only tag.

## Two places the marker still shows on a screen

Both are immutable by design, so neither was touched:

- **The one-tap offer card** on the five overdue-upkeep findings still reads the
  task's old name (`finding_actions.params.preventive_task_name`), because the
  frozen plan is what the manager was shown and Postgres refuses to edit it. The
  next nightly findings run supersedes these with fresh params carrying the new
  names.
- **The inventory History panel** on Port Arthur Inn still labels 135 ledger
  entries `[QA seed] …`, because the inventory audit ledger cannot be edited or
  deleted.

## Renamed rows

Renames applied (specific first, then the generic marker strip):

- `[QA seed] PTAC units` → `PTAC units — floors 2-3`
- `Water heater flush - chat [QA seed]` → `Water heater flush — boiler room`
- ` · [QA seed]`, `[QA seed] `, ` [QA seed]` → removed

### `accounts.display_name` — 6 row(s)

| id | was | is now |
|---|---|---|
| `c0000001-0000-4000-8000-000000000006` | [QA seed] Dolores Dial | Dolores Dial |
| `c0000001-0000-4000-8000-000000000003` | [QA seed] Fern Finley | Fern Finley |
| `c0000001-0000-4000-8000-000000000005` | [QA seed] Greta Gonzalez | Greta Gonzalez |
| `c0000001-0000-4000-8000-000000000004` | [QA seed] Gus Grant | Gus Grant |
| `c0000001-0000-4000-8000-000000000002` | [QA seed] Maria Delgado | Maria Delgado |
| `c0000001-0000-4000-8000-000000000001` | [QA seed] Oona Ortega | Oona Ortega |

### `agent_messages.content` — 5 row(s)

The talk-to-set-up demo transcript on Test Hotel. `tool_args` / `tool_result` on
the same rows keep their `[QA seed]` markers — machine payloads, never rendered.

| id | was | is now |
|---|---|---|
| `ad2214f2-e62d-4def-8094-201e8aa60b81` | We flush the water heaters every six months… Call it "Water heater flush - chat [QA seed]" | …Call it "Water heater flush — boiler room" |
| `4b0d6cd2-4795-4513-a147-cbec0d287fe6` | We flush the water heaters every six months… Call it "Water heater flush - chat [QA seed]" | …Call it "Water heater flush — boiler room" |
| `2d77314f-6184-4514-aea8-fa933bc46a6f` | Here's the setup: **Water heater flush - chat [QA seed]** — every 180 days… | Here's the setup: **Water heater flush — boiler room** — every 180 days… |
| `851adb1b-1a97-4f73-b54f-cd6174bb5966` | Saved — "Water heater flush - chat [QA seed]" is now on the schedule… | Saved — "Water heater flush — boiler room" is now on the schedule… |
| `86bd6522-4404-4609-adeb-ae2396eeb4db` | Six things waiting on you: … **[QA seed] PTAC units** … | … **PTAC units — floors 2-3** … |

### `company_findings.evidence` — 3 row(s)

| id | was | is now |
|---|---|---|
| `d492180d-4a18-4b66-ab33-eeaf96c8f34c` | jsonb | params.hotels prettied |
| `dca494b9-57ac-4764-a7b6-19e01cdbf436` | jsonb | params.hotels prettied |
| `ff5673d9-7e33-42aa-aff1-f04846f8c76f` | jsonb | params.hotels prettied |

### `company_findings.summary` — 3 row(s)

| id | was | is now |
|---|---|---|
| `dca494b9-57ac-4764-a7b6-19e01cdbf436` | [QA seed] Port Arthur Inn is the outlier on supplies: [QA seed] Port Arthur Inn $6,760, Testing Hotel $2,100, Test Hotel $700 on comparable weeks, aga… | Port Arthur Inn is the outlier on supplies: Port Arthur Inn $6,760, Testing Hotel $2,100, Test Hotel $700 on comparable weeks, against a $2,100 middle… |
| `ff5673d9-7e33-42aa-aff1-f04846f8c76f` | [QA seed] Port Arthur Inn is the outlier on supplies: [QA seed] Port Arthur Inn $6,760, Testing Hotel $2,100, Test Hotel $700 on comparable weeks, aga… | Port Arthur Inn is the outlier on supplies: Port Arthur Inn $6,760, Testing Hotel $2,100, Test Hotel $700 on comparable weeks, against a $2,100 middle… |
| `d492180d-4a18-4b66-ab33-eeaf96c8f34c` | 3 of your hotels stopped recording the daily numbers: Test Hotel, Testing Hotel and [QA seed] Port Arthur Inn. The longest silence is 8 days, at Testi… | 3 of your hotels stopped recording the daily numbers: Test Hotel, Testing Hotel and Port Arthur Inn. The longest silence is 8 days, at Testing Hotel. |

### `company_knowledge.created_by_name` — 3 row(s)

| id | was | is now |
|---|---|---|
| `23fcd6bb-512b-4363-b370-6c5a27e704c5` | [QA seed] Maria Delgado | Maria Delgado |
| `75c4c8d9-dde2-4eb4-9765-7b9cec2bf122` | [QA seed] Maria Delgado | Maria Delgado |
| `a396b62d-7b7a-48a2-883f-0960bd453eb3` | [QA seed] Maria Delgado | Maria Delgado |

### `complaints.description` — 13 row(s)

| id | was | is now |
|---|---|---|
| `2d07cb7b-d8a7-4ede-932b-8485ebc5198f` | [QA seed] AC blowing warm air in 214 | AC blowing warm air in 214 |
| `5eab6dc4-a019-49ef-8f4a-bd7d2658ab98` | [QA seed] AC leaking onto the carpet in 214 | AC leaking onto the carpet in 214 |
| `60fd46d5-4e76-4a2f-83f1-dbda53a81610` | [QA seed] AC not cooling in 214 | AC not cooling in 214 |
| `3df8d36f-765b-46c6-b18d-b5b786b89b97` | [QA seed] AC rattling in 214 | AC rattling in 214 |
| `66ecc74f-b67b-45a4-96fb-3789520e48fb` | [QA seed] bathroom not cleaned properly in 305 | bathroom not cleaned properly in 305 |
| `ff293770-3f1d-4480-b865-0302be5d7a8a` | [QA seed] carpet stains in 305 | carpet stains in 305 |
| `23e0089a-80f8-48cd-9ab7-034883328f5b` | [QA seed] dusty vents in 305 | dusty vents in 305 |
| `1e46c2fc-3961-4bb3-85fa-519adb730cd7` | [QA seed] front desk slow to respond for 410 | front desk slow to respond for 410 |
| `d611f277-ef84-40e8-8b96-44d3a46b5409` | [QA seed] iron missing in 512 | iron missing in 512 |
| `d234bdf6-7035-4558-aca5-1d62fbd45963` | [QA seed] luggage never delivered to 410 | luggage never delivered to 410 |
| `9cf2d1ce-c1ac-4cce-81ca-66eecba366b1` | [QA seed] no coffee pods in 512 | no coffee pods in 512 |
| `19cd2f30-f474-4ca3-b52c-78f90d2bd13b` | [QA seed] no wake-up call for 410 | no wake-up call for 410 |
| `cfc96ed5-ce5c-456e-81ab-54673468a047` | [QA seed] TV remote missing in 512 | TV remote missing in 512 |

### `equipment.name` — 3 row(s)

| id | was | is now |
|---|---|---|
| `e2000009-0000-4000-8000-000000000002` | [QA seed] Dryer #1 | Dryer #1 |
| `e0000009-0000-4000-8000-000000000001` | [QA seed] PTAC units | PTAC units — floors 2-3 |
| `e2000009-0000-4000-8000-000000000001` | [QA seed] Rooftop RTU-2 | Rooftop RTU-2 |

### `equipment.notes` — 3 row(s)

| id | was | is now |
|---|---|---|
| `e2000009-0000-4000-8000-000000000001` | [QA seed] | (cleared) |
| `e2000009-0000-4000-8000-000000000002` | [QA seed] | (cleared) |
| `e0000009-0000-4000-8000-000000000001` | [QA seed] Forty units, original to the 2019 refit. | Forty units, original to the 2019 refit. |

### `findings.evidence` — 15 row(s)

| id | was | is now |
|---|---|---|
| `00660375-a728-4326-9f65-a152cabbf4c7` | jsonb | basis/params names prettied; params.qa_seed kept |
| `0759fa78-4c8a-4935-b7aa-baaf2db57075` | jsonb | basis/params names prettied; params.qa_seed kept |
| `1936c4a4-6c9c-4941-89eb-1a3af2306918` | jsonb | basis/params names prettied; params.qa_seed kept |
| `3ca36e4d-8089-4116-a216-9564723b0da8` | jsonb | basis/params names prettied; params.qa_seed kept |
| `4c0660c0-0233-44d5-aef2-13b411074cec` | jsonb | basis/params names prettied; params.qa_seed kept |
| `567353de-76dc-41de-9aa7-81088bfe2563` | jsonb | basis/params names prettied; params.qa_seed kept |
| `61cd1477-c2a0-4a5c-b7ce-6435c1fd70c8` | jsonb | basis/params names prettied; params.qa_seed kept |
| `76a8a81c-c3b6-4b2c-8623-030d0662459f` | jsonb | basis/params names prettied; params.qa_seed kept |
| `7ac17528-50bc-4b54-bae8-be46a6ed7427` | jsonb | basis/params names prettied; params.qa_seed kept |
| `814e60fd-1598-4ed5-80be-8cc3d4354cdf` | jsonb | basis/params names prettied; params.qa_seed kept |
| `94355584-d3cc-4fdf-a48d-081808221fc5` | jsonb | basis/params names prettied; params.qa_seed kept |
| `96a8331b-2218-449d-bbe7-04ca79f1da47` | jsonb | basis/params names prettied; params.qa_seed kept |
| `bdb5ec12-040f-43fc-8c3f-05360827e0a1` | jsonb | basis/params names prettied; params.qa_seed kept |
| `ccecf53f-9ec9-445c-b802-bbe5a73a0cde` | jsonb | basis/params names prettied; params.qa_seed kept |
| `eb3fca1e-f936-4686-a03b-fa1e4b8cdf60` | jsonb | basis/params names prettied; params.qa_seed kept |

### `findings.judged_summary_en` — 3 row(s)

| id | was | is now |
|---|---|---|
| `7ac17528-50bc-4b54-bae8-be46a6ed7427` | [QA seed] PTAC units (installed 2019) has had 4 work orders in the last 60 days — 1 still open. Estimated cost: $800-$1600. | PTAC units — floors 2-3 (installed 2019) has had 4 work orders in the last 60 days — 1 still open. Estimated cost: $800-$1600. |
| `00660375-a728-4326-9f65-a152cabbf4c7` | Fire extinguisher check [QA seed] is 35 days overdue; somebody was called 9 days ago and it is still not done. Follow up to confirm whether it is sche… | Fire extinguisher check is 35 days overdue; somebody was called 9 days ago and it is still not done. Follow up to confirm whether it is scheduled or b… |
| `bdb5ec12-040f-43fc-8c3f-05360827e0a1` | Water heater flush [QA seed] is 30 days overdue. Schedule this maintenance to prevent system failure. | Water heater flush is 30 days overdue. Schedule this maintenance to prevent system failure. |

### `findings.judged_summary_es` — 2 row(s)

| id | was | is now |
|---|---|---|
| `00660375-a728-4326-9f65-a152cabbf4c7` | Fire extinguisher check [QA seed] está 35 días vencida; alguien fue contactado hace 9 días y todavía no está hecho. Haz seguimiento para confirmar si … | Fire extinguisher check está 35 días vencida; alguien fue contactado hace 9 días y todavía no está hecho. Haz seguimiento para confirmar si está agend… |
| `bdb5ec12-040f-43fc-8c3f-05360827e0a1` | Water heater flush [QA seed] está 30 días vencida. Agenda este mantenimiento para evitar falla del sistema. | Water heater flush está 30 días vencida. Agenda este mantenimiento para evitar falla del sistema. |

### `findings.summary` — 10 row(s)

| id | was | is now |
|---|---|---|
| `94355584-d3cc-4fdf-a48d-081808221fc5` | [QA seed] Backflow preventer test (Mechanical room) is 26 days past due — last done 391 days ago, and this hotel does it every 365 days. | Backflow preventer test (Mechanical room) is 26 days past due — last done 391 days ago, and this hotel does it every 365 days. |
| `96a8331b-2218-449d-bbe7-04ca79f1da47` | [QA seed] Fire panel inspection (Front office) is 24 days past due — last done 389 days ago, and this hotel does it every 365 days. | Fire panel inspection (Front office) is 24 days past due — last done 389 days ago, and this hotel does it every 365 days. |
| `567353de-76dc-41de-9aa7-81088bfe2563` | [QA seed] Grease trap service (Kitchen) is 38 days past due — last done 128 days ago, and this hotel does it every 90 days. | Grease trap service (Kitchen) is 38 days past due — last done 128 days ago, and this hotel does it every 90 days. |
| `3ca36e4d-8089-4116-a216-9564723b0da8` | [QA seed] Pool filter backwash (Pool) is 2 days past due — last done 16 days ago, and this hotel does it every 14 days. | Pool filter backwash (Pool) is 2 days past due — last done 16 days ago, and this hotel does it every 14 days. |
| `7ac17528-50bc-4b54-bae8-be46a6ed7427` | [QA seed] PTAC units (installed 2019) has had 4 work orders in the last 60 days — 1 still open. | PTAC units — floors 2-3 (installed 2019) has had 4 work orders in the last 60 days — 1 still open. |
| `4c0660c0-0233-44d5-aef2-13b411074cec` | [QA seed] Rooftop RTU-2 (installed 2018) has had 4 work orders in the last 60 days — 2 still open. | Rooftop RTU-2 (installed 2018) has had 4 work orders in the last 60 days — 2 still open. |
| `c2ad2e2f-8cd7-4bdf-98fb-48c6f0e808e6` | [QA seed] Room 214 has had 4 work orders in the last 30 days. | Room 214 has had 4 work orders in the last 30 days. |
| `99db9879-0ebf-4c5e-8909-ebd74c21c301` | [QA seed] The boiler at Testing Hotel has needed a call-out three weeks running. | The boiler at Testing Hotel has needed a call-out three weeks running. |
| `00660375-a728-4326-9f65-a152cabbf4c7` | Fire extinguisher check [QA seed] (Building) still has not been done — 35 days past due. Somebody was called about it 9 days ago. | Fire extinguisher check (Building) still has not been done — 35 days past due. Somebody was called about it 9 days ago. |
| `bdb5ec12-040f-43fc-8c3f-05360827e0a1` | Water heater flush [QA seed] (Building) is 30 days past due — last done 210 days ago, and this hotel does it every 180 days. | Water heater flush (Building) is 30 days past due — last done 210 days ago, and this hotel does it every 180 days. |

### `inventory_orders.item_name` — 131 row(s)

| id | was | is now |
|---|---|---|
| `0cb44857-3856-4670-80f8-03e7ec3f151b` | [QA seed] All-purpose cleaner | All-purpose cleaner |
| `bb1b3d4b-50c7-465d-b531-7895d84c3dd3` | [QA seed] All-purpose cleaner | All-purpose cleaner |
| `38051a3b-0017-4098-bc03-d3545f99cf24` | [QA seed] Bath towels | Bath towels |
| `7ebc81ea-1beb-4e0c-a48b-ab289b0a8ce5` | [QA seed] Bath towels | Bath towels |
| `ba1ecd71-ab53-48fa-bf51-2014f53a8b01` | [QA seed] Bath towels | Bath towels |
| `d012e35f-21f8-4195-adfe-77b5a6a5019d` | [QA seed] Bath towels | Bath towels |
| `37f88746-28d0-4d9e-8ea5-55ea9916c911` | [QA seed] Coffee packs | Coffee packs |
| `6355ec48-e9f2-43b6-9f26-25657552c42e` | [QA seed] Coffee packs | Coffee packs |
| `641ba8e5-8dd1-43aa-a5b1-fdab2e209e9f` | [QA seed] Coffee packs | Coffee packs |
| `e3d36dbe-857d-41eb-a54e-7e25649f980c` | [QA seed] Queen sheets | Queen sheets |
| `fbeaffa3-1aa8-475d-8c5c-3704f2b58bb8` | [QA seed] Queen sheets | Queen sheets |
| `03f41209-8f88-4430-a4d1-96caaafd40c3` | [QA seed] Towels | Towels |
| `07311928-6d5a-4350-8b27-0b1435980028` | [QA seed] Towels | Towels |
| `0a2d7411-3abe-43e7-988e-b3de57720cfb` | [QA seed] Towels | Towels |
| `0b562903-ff24-463c-80fa-9fb8109604a6` | [QA seed] Towels | Towels |
| `0d78dffc-f89e-47da-ab87-c13951e66e91` | [QA seed] Towels | Towels |
| `0f1c8776-fcb5-43af-8db8-f71d9cc6930a` | [QA seed] Towels | Towels |
| `0fb34ee4-cc74-4ffe-adc5-a957c6b0475b` | [QA seed] Towels | Towels |
| `1100955e-311e-4ffb-991c-308eb4c38b29` | [QA seed] Towels | Towels |
| `1102392e-f9de-4bbb-9e63-18eddbe10774` | [QA seed] Towels | Towels |
| `12db90a4-a230-4943-af00-f38d25bac0b6` | [QA seed] Towels | Towels |
| `141e4d91-29dd-4fcd-978b-3f5fc25be215` | [QA seed] Towels | Towels |
| `16cc5d83-5821-44c4-8e53-d363f1fd9283` | [QA seed] Towels | Towels |
| `187b01b8-35dd-41c6-a2c7-ca9488878af2` | [QA seed] Towels | Towels |
| `1bf77083-8cc2-4acb-a25c-8d94fa723011` | [QA seed] Towels | Towels |
| `1cb048e4-d004-4249-bf30-2b2acb738a53` | [QA seed] Towels | Towels |
| `1cf8d1d7-020f-4570-975f-b23330907cec` | [QA seed] Towels | Towels |
| `1e2ea266-bc69-4701-9761-4879ea10d3d9` | [QA seed] Towels | Towels |
| `232b8cc1-bc16-4a86-b739-1cd5371efcb0` | [QA seed] Towels | Towels |
| `27314fb5-558c-46a4-9c2a-0bda3ac2b800` | [QA seed] Towels | Towels |
| `27533f5f-1ddb-4b09-9773-3b1967937646` | [QA seed] Towels | Towels |
| `28088bc0-8cd4-4364-829a-c24290e3726e` | [QA seed] Towels | Towels |
| `2c484671-4f37-4e5c-93b8-41f8b0b92d49` | [QA seed] Towels | Towels |
| `2c79df87-9bb9-4cb6-b69f-9bb67fba8420` | [QA seed] Towels | Towels |
| `2c9412e9-b1ae-4af6-8139-deb038c43dcb` | [QA seed] Towels | Towels |
| `306003e7-271a-48d6-81cb-c8d2f3224032` | [QA seed] Towels | Towels |
| `3101f4bb-a9a4-443e-8fe5-7222a9a65530` | [QA seed] Towels | Towels |
| `32aba12a-1cc1-4947-a823-9ae05f3a02d0` | [QA seed] Towels | Towels |
| `332a2a3f-6247-4eaf-b226-801ebed21a61` | [QA seed] Towels | Towels |
| `341a9532-7483-4bbb-9283-eeeec71a7a26` | [QA seed] Towels | Towels |
| `3758a88a-3c10-4c69-9292-52e45d4f387d` | [QA seed] Towels | Towels |
| `37a065e4-aadb-4303-875f-ff0f91836ffb` | [QA seed] Towels | Towels |
| `395e3952-fb72-438d-8d26-35dc3fa040d8` | [QA seed] Towels | Towels |
| `3f10e7ee-fa40-488a-be96-46215c973638` | [QA seed] Towels | Towels |
| `433d1146-b4ec-48fb-b6a6-fda8827e961a` | [QA seed] Towels | Towels |
| `43e33607-9250-488f-a5ea-a5f23d5129a4` | [QA seed] Towels | Towels |
| `4421d9d4-294f-4428-beb8-80bccb9ac3f9` | [QA seed] Towels | Towels |
| `479c971f-b6c4-4230-a789-a16e164dfa18` | [QA seed] Towels | Towels |
| `48c6558c-b7f3-4f5d-aeb9-e7542d7ce31d` | [QA seed] Towels | Towels |
| `49d89573-8b79-4cc4-b5aa-3da25460b96c` | [QA seed] Towels | Towels |
| `4adaa7e0-9852-4c5c-a916-aba961e89474` | [QA seed] Towels | Towels |
| `4d36a498-2ae0-41a7-a313-652f5019b655` | [QA seed] Towels | Towels |
| `4d7926a9-ef93-4ebd-96f7-aa2822a1cc9f` | [QA seed] Towels | Towels |
| `4db9f13d-2f11-4c33-a421-e3c000960a98` | [QA seed] Towels | Towels |
| `4f793aaa-84c7-4655-8f23-ccef4454bf44` | [QA seed] Towels | Towels |
| `5090a239-52e0-4f54-ae69-4fea31b3da89` | [QA seed] Towels | Towels |
| `533e20fe-5a05-408f-8ccf-895de6e25768` | [QA seed] Towels | Towels |
| `5405d360-5a32-4e63-930f-26ecbce1e7ef` | [QA seed] Towels | Towels |
| `55e1f63c-a0cb-43c4-82f7-a097d05108da` | [QA seed] Towels | Towels |
| `56f609e1-f2d4-47f1-a83c-97c5e6f99c03` | [QA seed] Towels | Towels |
| `57d1aee3-3564-4e60-80a3-0ab957b2f602` | [QA seed] Towels | Towels |
| `58ba82da-ad4e-4b77-b652-0b8f7019ee77` | [QA seed] Towels | Towels |
| `58e48bc3-8cca-4550-8ea7-2e032e6f97c8` | [QA seed] Towels | Towels |
| `5aa320a9-2305-4fba-a9d7-ebffd5de71df` | [QA seed] Towels | Towels |
| `5bbb8047-e4bc-41da-8ac0-f6130942195c` | [QA seed] Towels | Towels |
| `5c7c1959-fb16-42d2-b071-c0ab5428b84d` | [QA seed] Towels | Towels |
| `6008fe48-20d0-490f-996b-c868dbd4a401` | [QA seed] Towels | Towels |
| `602382b3-efd8-477e-ab8c-9a5f7edfb0a2` | [QA seed] Towels | Towels |
| `61d58d1e-a6ae-4ee5-8f31-df68ce8b7517` | [QA seed] Towels | Towels |
| `6535b866-06f5-475c-b0b7-2bf11134fbcb` | [QA seed] Towels | Towels |
| `65c533a2-0f58-4143-af2b-c3ecfe893de4` | [QA seed] Towels | Towels |
| `67878826-faf0-4362-a50a-b462133ed9e4` | [QA seed] Towels | Towels |
| `6b8a3721-fc3e-483e-812e-b138f7d924c5` | [QA seed] Towels | Towels |
| `6c3b7cf2-aff0-4132-8768-89ada4ed4f55` | [QA seed] Towels | Towels |
| `72940096-1344-489a-8929-5a70e284b4ac` | [QA seed] Towels | Towels |
| `72a04a2c-5bae-44ba-b779-d8d32e330e62` | [QA seed] Towels | Towels |
| `740b1d14-35d4-459a-850c-38f2487831b6` | [QA seed] Towels | Towels |
| `74ebae87-1ca4-4ed6-92ca-bd86870ac7b2` | [QA seed] Towels | Towels |
| `76c04ab0-0ed8-4833-b616-e328422e774b` | [QA seed] Towels | Towels |
| `7c1f4578-04a7-48e9-a936-8aaaa4581a98` | [QA seed] Towels | Towels |
| `7ce3aa51-b6a3-4d77-9457-b147ce80ee7a` | [QA seed] Towels | Towels |
| `7d516632-38fa-4294-9a30-a38ac5b1e730` | [QA seed] Towels | Towels |
| `7ecb14e7-b3b4-4577-a472-49f4bd3e4e01` | [QA seed] Towels | Towels |
| `814aef4b-a197-4503-9ae1-9ea3d25c5fe8` | [QA seed] Towels | Towels |
| `82c9ec84-8e15-4e0a-aa37-eca91409978c` | [QA seed] Towels | Towels |
| `87444dce-6986-4df1-885e-767c32ed814d` | [QA seed] Towels | Towels |
| `880311e4-6a73-4d43-a40f-16104f1a3f50` | [QA seed] Towels | Towels |
| `88dab544-4618-4964-bdd0-bd169bba44f6` | [QA seed] Towels | Towels |
| `89bcbae3-4cb7-4b20-8495-d61809bc0e52` | [QA seed] Towels | Towels |
| `8c758c0a-075f-4aa4-b9e0-1c954fa2dd30` | [QA seed] Towels | Towels |
| `8d981968-7a50-4ae1-bbab-4d03612f7436` | [QA seed] Towels | Towels |
| `9350057b-796a-41bc-a446-069f9d80fa2d` | [QA seed] Towels | Towels |
| `9385a7de-b266-4bc3-a7cf-1541f2cd4639` | [QA seed] Towels | Towels |
| `9439c878-a23b-473b-96c7-3aef421e6f5a` | [QA seed] Towels | Towels |
| `970c7526-624c-4a9e-9d07-2dfff2c3c722` | [QA seed] Towels | Towels |
| `9897110e-a447-47a7-b90f-bf701f36a73a` | [QA seed] Towels | Towels |
| `99a81d5a-c1bc-4e39-910d-6943d504906b` | [QA seed] Towels | Towels |
| `a1dffd7a-3b91-45d0-a509-a27759884f85` | [QA seed] Towels | Towels |
| `a9083ab3-5177-473d-8f2b-7fdf3b9131e1` | [QA seed] Towels | Towels |
| `ad641777-d2a9-4b9c-9c33-202a653e47f9` | [QA seed] Towels | Towels |
| `ad674528-f440-485e-a3eb-189ba054b118` | [QA seed] Towels | Towels |
| `afd017da-48bc-43c7-b6fe-5c94b4ccc6f7` | [QA seed] Towels | Towels |
| `b54bdd15-752d-4728-a440-417440711d8a` | [QA seed] Towels | Towels |
| `ba426986-a40d-43f5-a046-4a90ff7818f9` | [QA seed] Towels | Towels |
| `bb053eef-920f-46da-94a8-9719857ae701` | [QA seed] Towels | Towels |
| `bc06c239-0bea-447c-8bf2-473c2bcdbdf9` | [QA seed] Towels | Towels |
| `bf95c8f3-7f1d-485d-980b-b1057395ff10` | [QA seed] Towels | Towels |
| `c30e64aa-145f-4fee-ab35-9017f5d9ef5f` | [QA seed] Towels | Towels |
| `c68c5427-cccb-46c6-9f73-46e3dbd9d6d1` | [QA seed] Towels | Towels |
| `c815d898-8ec8-45eb-92bd-6f63b530f2bb` | [QA seed] Towels | Towels |
| `c915fd59-ae7f-4fd2-a60e-3fa64241f7d7` | [QA seed] Towels | Towels |
| `cdc04ebc-121f-4512-a1df-907da5c7e49d` | [QA seed] Towels | Towels |
| `cf8d0c51-e548-4a09-bfba-b3f3d10279c4` | [QA seed] Towels | Towels |
| `d48503ce-59e6-4035-823e-836d7467bc9e` | [QA seed] Towels | Towels |
| `d7971df2-f1f6-4d36-9735-088d5b6cb5ad` | [QA seed] Towels | Towels |
| `d9da9857-e99b-4957-8290-36a52aec3d91` | [QA seed] Towels | Towels |
| `d9ddf70e-ee1d-4bec-a519-7acd8570c117` | [QA seed] Towels | Towels |
| `da7704fd-e11b-4083-ae1b-bfd6b4b9120e` | [QA seed] Towels | Towels |
| `db0c6d32-c34a-49f6-a75d-ab6548c378ad` | [QA seed] Towels | Towels |
| `def8f010-e812-4201-84ed-7685be4f5e3a` | [QA seed] Towels | Towels |
| `e2562db7-8eff-4e6e-8613-f61ebb11aba7` | [QA seed] Towels | Towels |
| `e88db018-727d-4ec9-9ec7-2886fe7072c0` | [QA seed] Towels | Towels |
| `eab8fba8-a542-4cc6-a405-d21f509c0654` | [QA seed] Towels | Towels |
| `eb5fd1f9-d8a7-45c3-9fa7-c5374edb3bf3` | [QA seed] Towels | Towels |
| `edcf2e8f-eead-4be6-8a38-8f51da8b375b` | [QA seed] Towels | Towels |
| `f0036d94-02ee-4812-ac63-18afad72ae14` | [QA seed] Towels | Towels |
| `f12e4b4e-6e12-4c33-9a7a-774c74db0d41` | [QA seed] Towels | Towels |
| `f5aedfec-a81c-44a7-b5fa-6b7c732a16df` | [QA seed] Towels | Towels |
| `f6c63a85-0a36-4544-97e2-90f888642770` | [QA seed] Towels | Towels |
| `f914e226-3ae6-4645-bccc-664bfc76e2b4` | [QA seed] Towels | Towels |
| `fd94f9af-d9ce-4c98-aa1c-e344993c792a` | [QA seed] Towels | Towels |

### `inventory_rate_predictions.item_name` — 3 row(s)

| id | was | is now |
|---|---|---|
| `23043f13-eb35-45d3-8dc1-829acf0a44ef` | [QA seed] All-purpose cleaner | All-purpose cleaner |
| `d9c63da9-6689-4b55-b4b6-a355aae6b932` | [QA seed] Bath towels | Bath towels |
| `07fe7470-fdf0-40d4-8693-1035d40c2555` | [QA seed] Queen sheets | Queen sheets |

### `inventory.name` — 4 row(s)

| id | was | is now |
|---|---|---|
| `e3000001-0000-4000-8000-000000000004` | [QA seed] All-purpose cleaner | All-purpose cleaner |
| `e3000001-0000-4000-8000-000000000001` | [QA seed] Bath towels | Bath towels |
| `e3000001-0000-4000-8000-000000000003` | [QA seed] Coffee packs | Coffee packs |
| `e3000001-0000-4000-8000-000000000002` | [QA seed] Queen sheets | Queen sheets |

### `organizations` — 2 row(s)

| id | was | is now |
|---|---|---|
| `11110000-0000-4000-8000-0000000000a1` | [QA seed] Gulf Coast Hotels | Gulf Coast Hotels |
| `0cb05fe5-f256-453e-b8a5-b3805ac3142f` | [QA seed] Port Arthur Inn | Port Arthur Inn |

### `preventive_tasks` — 9 row(s)

| id | was | is now |
|---|---|---|
| `a2000001-0000-4000-8000-000000000001` | [QA seed] Backflow preventer test | Backflow preventer test |
| `a2000001-0000-4000-8000-000000000003` | [QA seed] Emergency lighting walk | Emergency lighting walk |
| `a3000001-0000-4000-8000-000000000001` | [QA seed] Fire panel inspection | Fire panel inspection |
| `a2000001-0000-4000-8000-000000000002` | [QA seed] Grease trap service | Grease trap service |
| `a3000001-0000-4000-8000-000000000002` | [QA seed] Pool filter backwash | Pool filter backwash |
| `0321d9fe-305f-481b-ab48-476a5bd99b50` | Fire extinguisher check [QA seed] | Fire extinguisher check |
| `2796a03a-29df-4a57-a64e-b93b6346d758` | PTAC filter clean [QA seed] | PTAC filter clean |
| `54aa587b-615f-4bfb-b4ff-943a3041f195` | Water heater flush - chat [QA seed] | Water heater flush — boiler room |
| `ce95c405-f23a-4aba-8c5a-27602361676c` | Water heater flush [QA seed] | Water heater flush |

### `properties` — 1 row(s)

| id | was | is now |
|---|---|---|
| `cc000003-0000-4000-8000-000000000003` | [QA seed] Port Arthur Inn | Port Arthur Inn |

### `work_orders.description` — 28 row(s)

| id | was | is now |
|---|---|---|
| `106a6a9f-2759-4e04-9b4c-7222e821ce12` | [QA seed] AC blowing warm again | AC blowing warm again |
| `d10e143c-c4f2-4778-9995-9cd6b949b487` | [QA seed] AC blowing warm, filter looked dirty. | AC blowing warm, filter looked dirty. |
| `a3aa5ef8-67d1-4d66-b787-f6450d8045b3` | [QA seed] AC noisy again overnight. | AC noisy again overnight. |
| `ae59b046-845f-4141-ad20-54a63dfe6e35` | [QA seed] Blackout curtain torn | Blackout curtain torn |
| `45419231-fd1c-4c59-b483-edd9b66597d8` | [QA seed] COMPRESSOR icing up again | COMPRESSOR icing up again |
| `e3983042-faf7-48f4-84da-54949887dcee` | [QA seed] COMPRESSOR loud on start | COMPRESSOR loud on start |
| `3ebeec70-928d-4782-9ae4-25507e08582b` | [QA seed] COMPRESSOR needs a look | COMPRESSOR needs a look |
| `713a7417-4a96-41a1-8b74-9e52161cdb22` | [QA seed] COMPRESSOR rattling overnight | COMPRESSOR rattling overnight |
| `9fe1db7e-1b17-4c47-b44d-4ead84c67d1e` | [QA seed] COMPRESSOR shut off, guest moved | COMPRESSOR shut off, guest moved |
| `1a7792ed-5371-4438-8dd0-b3ea65a5f4c8` | [QA seed] COMPRESSOR tripped the breaker | COMPRESSOR tripped the breaker |
| `318927f8-9a17-48bd-a086-320c1da9db2f` | [QA seed] Door closer replaced | Door closer replaced |
| `ae693ed0-e0bb-4ff9-8686-b8df171d0f7a` | [QA seed] Entry mat trip hazard | Entry mat trip hazard |
| `7e1eee63-62b3-4ac7-8644-4f67a4ce1254` | [QA seed] Fridge not cooling | Fridge not cooling |
| `8ce61cf3-f671-4ec3-a2a1-0c7298227fea` | [QA seed] Guest moved — unit failed overnight | Guest moved — unit failed overnight |
| `b32c84e1-29c6-4e5c-b22f-d9727834d7ca` | [QA seed] Pool light out | Pool light out |
| `3334d5b3-5385-426a-b01f-964554ea2282` | [QA seed] PTAC in 203 compressor short-cycling | PTAC in 203 compressor short-cycling |
| `3ba1ac5b-6cfd-4c73-8d8c-cb28a60fb0f9` | [QA seed] PTAC in 214 not cooling | PTAC in 214 not cooling |
| `031baef3-d521-4da4-9bc5-a83af0a602dc` | [QA seed] PTAC in 227 fan seized | PTAC in 227 fan seized |
| `f174cd9e-859b-4bfc-ba5b-45af30256f6b` | [QA seed] PTAC in 236 blowing warm | PTAC in 236 blowing warm |
| `e46b8654-647a-4183-8a0d-357ca2f67c10` | [QA seed] RTU-2 belt replaced | RTU-2 belt replaced |
| `92de520e-9076-4823-9e6c-0ea25bec7f2c` | [QA seed] RTU-2 compressor noise | RTU-2 compressor noise |
| `08f0d479-fa51-4c49-9324-4b911c5981da` | [QA seed] RTU-2 short-cycling | RTU-2 short-cycling |
| `30e5ae84-b8ce-4851-9258-5a30a8eb0551` | [QA seed] RTU-2 tripped the breaker | RTU-2 tripped the breaker |
| `a41b23fa-95d1-4d3a-bd89-aa47d858a1cc` | [QA seed] Shower diverter stuck | Shower diverter stuck |
| `36f001d3-a212-4785-8c0b-66528e8c5254` | [QA seed] Thermostat unresponsive | Thermostat unresponsive |
| `f6d7e2b6-706d-47ea-a2c2-4d6f7bf4c95d` | [QA seed] Thermostat unresponsive. | Thermostat unresponsive. |
| `4ac8e736-a5b7-491f-bbc3-5e9eb80cf625` | [QA seed] Toilet running | Toilet running |
| `79fff035-af5e-4caa-b0bc-171d7a4aff41` | [QA seed] Water pooling under the PTAC | Water pooling under the PTAC |
