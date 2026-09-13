# Industry interface

`public/industry.css` applies the supplied Phase 1 Industry design on top of the existing layout stylesheet. Tokens and shared component states live there; page modules should use these components rather than introduce another visual theme.

| Primitive                                   | Use / states                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--ground`, `--surface`, `--paper`, `--ink` | Technical background, recessed surfaces, readable panels and text                                                                       |
| `--steel`, `--steel-strong`, `--steel-wash` | Accent, readable action color, selected / informational surface                                                                         |
| `--line`, `--muted`, `--red`                | Hairline borders, secondary copy, errors                                                                                                |
| `heading()` / `.page-heading`               | Eyebrow, condensed heading, description, optional actions; title wraps on small screens                                                 |
| `panel()` / `.panel-heading`                | One related workflow or dataset, optional action; square border, no elevation                                                           |
| `button()` / `.btn`                         | Primary action, secondary action, danger and text variants; disabled and visible keyboard-focus states                                  |
| `table()` / `.table-scroll`                 | Labeled column headings, row hover, contained horizontal scrolling on mobile                                                            |
| `.stats` / `.stat`                          | Value, unit, source and time window; contiguous cells with responsive wrapping                                                          |
| `status()`                                  | Text plus semantic color; color is never the only status signal                                                                         |
| `modal()`                                   | Native dialog, retained input on errors, busy state, Escape and focus restoration; callback may return false to keep a review step open |
| `.billing-calculation`                      | Ordered source amounts followed by final requested amount                                                                               |
| `.application-document`                     | Reviewable, printable source snapshot; screen controls excluded from print                                                              |

Fonts are locally hosted Barlow regular/medium/bold and Barlow Condensed semibold, reused from the user's supplied redesign bundle. The [SIL Open Font License](public/fonts/OFL.txt) is included. System fallbacks are specified and no remote font request is required. The app icon uses the reference's wireframe and registration-mark motif as an SVG.

Do not introduce sample funded balances, verification badges, reviews, or payout-success states to reproduce the design mockup. Render them only when corresponding records and backend behavior exist.
