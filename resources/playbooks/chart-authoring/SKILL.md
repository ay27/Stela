---
name: chart-authoring
description: Rules for valid Stela chart presets, marks, channels, layers, and value formats.
---

# Chart authoring

Use this before the first `create_chart` call in a run. Keep aggregation in SQL and reference declared field ids from layer encodings.

## Preset and mark

| preset | allowed marks |
|---|---|
| trend | line, area |
| ranking | bar |
| composition | arc |
| distribution | histogram, boxplot |
| correlation | point |
| funnel | funnel |
| retention | rect |
| comparison | bar, line, area, point, rule |
| custom | any mark |

Only comparison and custom accept two layers. Two layers must share one x field and use only bar, line, area, point, or rule.

## Mark, channel, and type

| mark | required channels | type rules |
|---|---|---|
| bar | x, y | exactly one axis quantitative; the other categorical or temporal |
| line, area | x, y | y quantitative |
| point | x, y | y quantitative; correlation also requires quantitative x |
| arc | theta, color | theta quantitative; color nominal, ordinal, or boolean |
| rect | x, y, color | x/y nominal, ordinal, or temporal; color quantitative |
| rule | y | y quantitative |
| histogram | x | x quantitative |
| boxplot | y | y quantitative |
| funnel | x, y | x quantitative; y nominal or ordinal |

Any theta or size encoding must reference a quantitative field. Non-none stack is valid only for bar or area. bins is valid only for histogram and must be an integer from 5 through 50. temporalInput is valid only for temporal fields.

## Value format

- auto and text accept only nullLabel.
- number accepts minimumFractionDigits and maximumFractionDigits; minimum cannot exceed maximum.
- compact accepts maximumFractionDigits.
- percent requires input ratio or whole and accepts maximumFractionDigits.
- currency requires a three-letter uppercase ISO 4217 currency and accepts maximumFractionDigits.
- date and datetime accept input iso, epoch-ms, or epoch-seconds; style short, medium, or long; and timeZone local or UTC.
- duration requires input milliseconds or seconds and accepts style short or clock.
- boolean accepts trueLabel and falseLabel.
- Fraction digits are integers from 0 through 12. Every format kind accepts nullLabel.

## Stop and verify

Stop once the fields and layers satisfy these rules. Submit one `create_chart` call and use its validator result as the final authority.
