# 4B end-to-end verification

## Latest run (2026-11-05, commit `e34cc78`)

Run on a fresh clone with dsh `0.2.1-rc.5`, installed with `dsh plugin add`, using the local `qwen3.5-4b` model.

| Stage | Observed result |
| --- | --- |
| Tests | `npm test`: 140 tests, 140 passed. `npm pack --dry-run`: 17 files. |
| Draft | The turn ended `completed` after 3 tool calls and wrote `invoice-daily.csv` with `2026-10-27,20` and `2026-10-28,10`. Proposal `aggregate-invoice-daily-by-date` had `kind=new`, `drafter=llm`, and no draft errors. The project had no skills before acceptance. |
| Explicit acceptance | `scribe accept aggregate-invoice-daily-by-date --project "$E2E_ROOT"` installed the skill. The project copy and the accepted archive had the same SHA-256. |
| Fresh session | With the plugin disabled, the `skill` tool loaded the accepted skill. The final answer named `date` and `amount` as input columns and `date,total` as the output header. |

## Earlier run

Verified on 2026-11-05 JST with dsh `0.2.0-rc.2`, Node `v22.23.4`, and the local `llamacpp/qwen3.5-4b` route. The test used a dedicated project under `$DSH_ROOT/work/skill-scribe-e2e-20261105-r5`; no live skill directory was changed. The execution checkout HEAD was `ac41e8aeec1146a2dddf80738e703a155f4ed7ef`. The local evidence is at `$DSH_ROOT/work/skill-scribe-e2e-20261105-r5/e2e-proof.json`, `driver-events.jsonl`, and `fresh-run.log` (not part of this package).

| Stage | Observed result |
| --- | --- |
| Draft | Session `session-ea79f509-2f26-4783-9e29-a9784b53a389` ended `completed` after 5 non-skill tool calls (`read`, `glob`, `read`, `write`, `read`). `invoice-daily.csv` contained `2026-10-27,20` and `2026-10-28,10`. Proposal `aggregate-invoice-by-date` had `kind=new`, `drafter=llm`, and no draft errors. The name was absent from the skill catalog before acceptance. |
| Explicit acceptance | `scribe accept aggregate-invoice-by-date --project "$E2E_ROOT"` installed `.dsh/skills/aggregate-invoice-by-date/SKILL.md`. Its SHA-256 matched the accepted archive: `853b593f4dde14434862878e8fcbacd2842a95e20142cb9e111f8ec9bae92c6a`. |
| Fresh session | Session `session-bced562a-314f-48eb-83e0-013f4c91ccba` ended `completed`. The compressed session record's `<available_skills>` listed `aggregate-invoice-by-date`, and its `skill` tool loaded it from `$E2E_ROOT/.dsh/skills/aggregate-invoice-by-date`. The returned instructions matched the accepted file body; the project copy and accepted archive SHA-256 values also matched. The final answer identified `date` and `amount` as input columns and `date,total` as the output header. Candidate generation was disabled for this verification session. |

## Scope and limitations

The evidence above covers only the three listed stages: completed-turn proposal generation, explicit project acceptance, and discovery and loading in a fresh session. Update proposals and default-destination acceptance have unit-test coverage but were not exercised in this E2E. The statement that this plugin does not execute commands is based on static code inspection and unit tests, not proof of every runtime execution path. The plugin default `shutdownGraceMs=3000` allows up to 3 seconds for an in-flight draft during dsh one-shot shutdown processing; dsh's overall shutdown window is 5 seconds; a slow 4B draft can be interrupted at exit and leave no proposal. Drafting is asynchronous and does not hold up the main turn. Use a long-lived session or rerun through the backfill example.

The test-only driver keeps the runtime open while it observes the asynchronous proposal. The driver and patches are local test harness files, are not included in the package tarball, and are required to reproduce this E2E procedure. The tarball also omits `test/`; installed-package tests add `test/` from the same-revision checkout to an isolated installation. This is local verification evidence, not a tarball-only reproducible test.

## Local reproduction

Set `DSH_ROOT` to a dsh checkout with the local 4B model route. The test-only `driver.mjs`, `driver.patch.yml`, `scribe-home.patch.yml`, and `scribe-disabled.patch.yml` are retained in `$E2E_ROOT`; they are not plugin runtime files. The model patch also points `agentsHome` to an empty test directory. Replace paths in the patches if the checkout moves. Use only synthetic input and a dedicated project.

```bash
export DSH_ROOT=/path/to/dsh
export E2E_ROOT="$DSH_ROOT/work/skill-scribe-e2e-20261105-r5"
mkdir -p "$E2E_ROOT/scribe-home"
cat > "$E2E_ROOT/invoice.csv" <<'CSV'
date,amount
2026-10-27,11
2026-10-28,6
2026-10-27,9
2026-10-28,4
CSV
cd "$E2E_ROOT"
DSH_HOME="$DSH_ROOT/home" LLAMACPP_DUMMY_KEY=dummy "$DSH_ROOT/node_modules/.bin/dsh" \
  --profile headless --patch "$DSH_ROOT/plugins/model-4b.patch.yml" \
  --patch "$DSH_ROOT/plugins/scribe.patch.yml" \
  --patch "$E2E_ROOT/scribe-home.patch.yml" --patch "$E2E_ROOT/driver.patch.yml" \
  --json 'Read only the synthetic fixture invoice.csv in the current directory. Sum amount by date. Write invoice-daily.csv in the current directory with date,total rows sorted by date. Read the output to verify it. Make at least three tool calls. Do not read environment variables, files outside this directory, or other files; do not use network or the skill tool.'

# Inspect SKILL.md and meta.json before this explicit acceptance step.
DSH_HOME="$E2E_ROOT/scribe-home" node "$DSH_ROOT/plugins/dsh-skill-scribe/bin/scribe.js" \
  accept aggregate-invoice-by-date --project "$E2E_ROOT"

DSH_HOME="$DSH_ROOT/home" LLAMACPP_DUMMY_KEY=dummy "$DSH_ROOT/node_modules/.bin/dsh" \
  --profile headless --patch "$DSH_ROOT/plugins/model-4b.patch.yml" \
  --patch "$DSH_ROOT/plugins/scribe.patch.yml" \
  --patch "$E2E_ROOT/scribe-disabled.patch.yml" --json \
  'Load the skill named aggregate-invoice-by-date using the skill tool. Then state its required input columns and output header in one short sentence. Do not write any files. Do not read environment variables, files outside this project, or use network.'
```

The test-only driver replaces the one-shot `headless-runner` through a patch. It uses the same `agents.create` → `followup` → `whenIdle` → `sessions.flush` flow, then keeps the runtime open for up to 240 seconds to observe the asynchronous proposal. It does not extend the agent turn. The exact executed local driver SHA-256 was `bc66da0b955073e4b4c6476e3e696d57de20bf339d9ec3a76d2b0eb3da66f0be`; its patch SHA-256 was `0044529401754615d50b242feee2e04491d18a1c506f853e398ce3ec130539ce`. The two config overlays were `0e5a7cf0b61ea678c81fc66aa58bdcbcb6ca301e066a325ac95716a472054b8d` (dedicated proposal home) and `1a4685dc8a29505fb07b6b65c9db2a2c2ee2bedb7f851738c54e0df9f480a3e6` (generation disabled), respectively.

An earlier native one-shot run produced a `fallback` draft after its short shutdown window interrupted the LLM call; this was not counted as an LLM success or accepted. The current implementation leaves no proposal when drafting fails. The persistent driver is measurement harness code only; normal plugin behavior remains asynchronous.
