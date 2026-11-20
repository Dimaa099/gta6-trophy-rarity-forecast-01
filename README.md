# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Dimaa099/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Dimaa099/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A principled forecaster for GTA VI's PlayStation 5 trophy earn rates on Exophase: per-trophy saturating growth curves (logit rate against log-time since release) fitted on the house's reads, with slopes pooled across trophies of the same tier and an honest spread from fit uncertainty, extrapolation leverage, and one Exophase refresh worth of dilution. It writes five quantiles per trophy (5%, 25%, 50%, 75%, 95%) for the lowest pinball loss on the logit scale.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `<id>.in` case in the input directory and writes `<id>.out` for each: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`. It runs offline, deterministically, in well under the 8-second cap.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8y9tq87y&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
