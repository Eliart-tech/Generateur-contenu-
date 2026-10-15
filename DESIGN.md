---
name: Amorce
description: Un score est une prévision — une bande de potentiel, un indice de confiance, puis le relevé réel qui la vérifie.
colors:
  shell: "#0C315C"
  act: "#1C57B0"
  act-hover: "#174A97"
  act-soft: "#E3ECF9"
  act-ink: "#FFFFFF"
  cold: "#7FAAE6"
  mild: "#F2C845"
  tepid: "#F5A630"
  warm: "#F08A24"
  hot: "#CC3A22"
  thermal-ink: "#0D2240"
  hot-ink: "#FFFFFF"
  ok: "#1F7A4D"
  ok-soft: "#E2F3EA"
  warn-ink: "#8A4210"
  warn-soft: "#FDF0E1"
  err: "#B42318"
  err-soft: "#FDECEA"
  sky: "#E8F0FA"
  surface: "#FFFFFF"
  surface-2: "#F5F8FC"
  surface-3: "#EDF3FA"
  line: "#D2DEEC"
  line-2: "#E2EAF4"
  line-strong: "#9DB6D6"
  ink: "#0D2240"
  ink-2: "#3B5373"
  ink-3: "#5C7392"
  ink-on-shell: "#C6D6EB"
  ink-on-shell-2: "#8EA8CA"
  shell-hi: "rgba(255, 255, 255, 0.12)"
typography:
  display:
    fontFamily: '"Fira Sans Condensed", "Fira Sans", "Arial Narrow", sans-serif'
    fontSize: "68px"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "-0.02em"
    fontFeature: "'tnum' 1"
  headline:
    fontFamily: '"Fira Sans Condensed", "Fira Sans", "Arial Narrow", sans-serif'
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.005em"
  title-page:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.012em"
  title-flow:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title-script:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
  title-section:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
  script:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.62
  body:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  field:
    fontFamily: '"Fira Sans", "Segoe UI", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: '"Fira Sans Condensed", "Fira Sans", "Arial Narrow", sans-serif'
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  numeral:
    fontFamily: '"Fira Sans Condensed", "Fira Sans", "Arial Narrow", sans-serif'
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "'tnum' 1"
rounded:
  r-sm: "6px"
  shell-item: "8px"
  control: "9px"
  r: "10px"
  r-lg: "14px"
  pill: "999px"
spacing:
  tight: "8px"
  stack: "16px"
  panel: "28px"
  gutter: "clamp(20px, 3.4vw, 44px)"
components:
  button-primary:
    backgroundColor: "{colors.act}"
    textColor: "{colors.act-ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.act-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-quiet-hover:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
  button-large:
    rounded: "{rounded.r}"
    padding: "0 22px"
    height: "48px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  chip-platform:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 14px 0 12px"
    height: "42px"
  chip-platform-selected:
    backgroundColor: "{colors.act-soft}"
    textColor: "{colors.ink}"
  tab-platform:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "11px 11px 0 0"
    padding: "0 14px 0 16px"
    height: "48px"
  tab-platform-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    height: "49px"
  thermal-chip:
    backgroundColor: "{colors.mild}"
    textColor: "{colors.thermal-ink}"
    typography: "{typography.numeral}"
    rounded: "{rounded.r-sm}"
    padding: "0 7px"
    height: "26px"
  thermal-chip-hot:
    backgroundColor: "{colors.hot}"
    textColor: "{colors.hot-ink}"
  thermal-chip-small:
    rounded: "5px"
    padding: "0 5px"
    height: "22px"
  verdict-reading:
    textColor: "{colors.thermal-ink}"
    typography: "{typography.display}"
    rounded: "{rounded.r-lg}"
    width: "124px"
    height: "116px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.r-lg}"
    padding: "24px"
  nav-link:
    textColor: "{colors.ink-on-shell}"
    rounded: "{rounded.shell-item}"
    padding: "0 12px"
    height: "42px"
  nav-link-active:
    backgroundColor: "rgba(255, 255, 255, 0.14)"
    textColor: "#FFFFFF"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.r}"
    padding: "11px 16px"
  match-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "5px"
    padding: "4px 7px"
  match-near:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn-ink}"
    rounded: "5px"
    padding: "4px 7px"
  match-miss:
    backgroundColor: "{colors.err-soft}"
    textColor: "{colors.err}"
    rounded: "5px"
    padding: "4px 7px"
---

# Design System: Amorce

## Overview

**Creative North Star: "The Forecast Bulletin"**

Amorce reads like a weather bulletin for content. A score is a forecast, not a grade: a reading set on a thermal scale, a probability band (« Top 25 % de ta niche »), a confidence index, and a slot that waits for the observed reading which later verifies it (« Prévu · relevé »). Every screen is assembled from the instruments of a forecast — the thermometer block, the four-segment band scale with its needle, five confidence dots, the cartographic warm-front symbol for trends, and the route line that strings the steps of a forecast like weather stations. The world deliberately refuses the generic grey gauge dashboard and the "AI" look of violet gradients and sparkles; its colours come from the map and the thermometer.

The frame is a map-blue shell around a cold sky ground by day and a deep-blue night by night; the theme follows the device. Paper-white surfaces sit on the sky as flat tonal layers carrying a hairline shadow. Density is that of a working tool: 40px controls, 8–16px gaps inside groups, 28px between panel columns. The script being read is the largest running text on every screen, because the content is the product. Readings are set in Fira Sans Condensed, with tabular figures on scores, thermal chips and clocks; prose, headings and meta figures are set in Fira Sans.

Motion is a single authored moment per forecast, « le bulletin tombe »: the reading drops in and counts up, the needle slides to its band, the confidence dots light one by one, the factor bars fill. Everything else is quiet: colour and border changes take 140ms on `ease` (200ms for the confidence fill and the rewrite blur); movement (press, toast, chevrons, view entrances, sticky bar) takes 140–260ms on the exponential ease-out cubic-bezier(0.23, 1, 0.32, 1). View changes cross-fade (out 120ms, in 240ms rising 6px). Reduced motion is honoured as less and softer, never as nothing: all CSS animations collapse to 1ms (the busy spinner stops), view transitions are off, view entrances become a 160ms fade, presses don't scale, the sticky bar fades, smooth scrolling jumps, the verdict strip fades 40%→100% over 200ms, and a rewrite only fades the script from 50% to full over 200ms with no count-up.

**Key Characteristics:**
- A five-step thermal scale (cold, mild, tepid, warm, hot) codes every potential value and every band; Warm doubles as the brand's sun.
- Map-blue shell, cold-sky ground, paper surfaces; night is deep blue, never black.
- Confidence is five dots and tops out at four: a forecast is never certain.
- Step progress is a route line with stations, not a bar or a ring.
- The warm-front glyph marks every retained trend and live signal.
- Fira Sans for prose and meta, Fira Sans Condensed for readings; scores, chips, clocks and counted meta in tabular figures.
- Flat at rest; lift only on hover or for a transient message.

## Colors

A cartographer's palette: map blue for the frame and for action, a sky-to-paper neutral ramp, and a thermal scale reserved for potential.

### Primary
- **Map Blue** (#0C315C): the shell (sidebar, and the mobile top bar) and the browser `theme-color`. It is the bulletin's frame, never a content background. At night it deepens to #11294A, just above the night sky.
- **Action Blue** (#1C57B0): everything the user acts on and every instrument of the forecast itself — primary buttons, links, the caret, focus rings, the selected platform chip, completed route segments, the confidence dots, the calibration meter, numbered improvement counters, hashtags. **Action Blue Deep** (#174A97) is its hover; **Action Wash** (#E3ECF9) backs the selected platform chip and the angle tags (« Angle actuel », « Le plus porté »); **Action Ink** (#FFFFFF) is text on Action Blue (it flips to dark ink at night, when Action Blue lifts to a brighter blue).

### Secondary
The thermal scale. Each step is both a score range and, for four of them, a band.
- **Cold** (#7FAAE6): scores below 40; band « Bas 50 % ».
- **Mild** (#F2C845): scores 40–59; band « Top 50 % »; also the shell's warning status dot.
- **Tepid** (#F5A630): scores 60–74 (no band); also the bullet of format-warning flags and the border tint of notices.
- **Warm** (#F08A24): scores 75–84; band « Top 25 % »; and the brand's sun (see The One Sun Rule).
- **Hot** (#CC3A22): scores 85 and above; band « Top 10 % »; the stroke and fill of the warm-front glyph.
- **Thermal Ink** (#0D2240): text on cold, mild, tepid and warm fills. **Hot Ink** (#FFFFFF): text on Hot by day; at night it becomes dark ink because Hot lifts to a lighter red.

### Tertiary
Status pairs, each a strong ink on its own soft wash.
- **Verified Green** (#1F7A4D on #E2F3EA): a forecast that matched its reading (« Juste »), saved states, format conformity, completed run stages, the « Réécrit » stamp.
- **Rust Ink** (#8A4210 on #FDF0E1): one band off (« À une bande »), global notices, format flags, the « Priorité » tag on the weakest factor.
- **Alert Red** (#B42318 on #FDECEA): field errors, alerts, « Écart de N bandes », over-length tweets.

### Neutral
- **Cold Sky** (#E8F0FA): the page ground behind every view. Night sky is a deep navy (#0A1628).
- **Bulletin Paper** (#FFFFFF): cards, the bulletin, inputs, secondary buttons.
- **Paper Shade** (#F5F8FC): the bulletin's side panel, the open history detail, secondary-button hover.
- **Paper Wash** (#EDF3FA): skeletons, empty bar tracks, quiet-button hover, stage-direction tags, the pending reading block.
- **Chart Rule** (#D2DEEC): default 1px borders. **Faint Rule** (#E2EAF4): dividers inside a panel. **Strong Rule** (#9DB6D6): hover borders, the route line, empty chip outlines, dashed provisional borders, the scrollbar thumb.
- **Deep Ink** (#0D2240): primary text. **Slate Ink** (#3B5373): secondary text, verdict sentence, meta, and any small text on Cold Sky, Paper Wash or the band-tinted verdict strip. **Mist Ink** (#5C7392): tertiary meta and labels on Bulletin Paper and Paper Shade only.
- **Shell Inks** (#C6D6EB, #8EA8CA): nav text and the dimmer shell labels and status line; **Shell Highlight** (rgba(255, 255, 255, 0.12)) is the shell hover wash. The active nav item takes white at 14% with pure white text.

### Night
Under `prefers-color-scheme: dark` every token takes its night value:

| Token | Night |
|---|---|
| Map Blue | #11294A |
| Action Blue / Action Blue Deep / Action Wash / Action Ink | #4A86E8 / #6698EC / #16325A / #06101F |
| Cold / Mild / Tepid / Warm / Hot | #86AFEA / #F2CD55 / #F5AE42 / #F3953A / #E5583F |
| Thermal Ink / Hot Ink | #06101F / #06101F |
| Verified Green on its wash | #5BC48F on #10331F |
| Rust Ink on its wash | #F7B977 on #3A2412 |
| Alert Red on its wash | #FF8A80 on #3A1614 |
| Cold Sky | #0A1628 |
| Bulletin Paper / Paper Shade / Paper Wash | #10213A / #0D1C33 / #13284A |
| Chart Rule / Faint Rule / Strong Rule | #22395B / #1A2F4E / #3C5C86 |
| Deep Ink / Slate Ink / Mist Ink | #E7EEF8 / #AEC1DB / #8BA2C2 |
| Shell Inks / Shell Highlight | #B9CBE4, #7F98BA / rgba(255, 255, 255, 0.08) |

### Named Rules
**The Thermal Scale Rule.** A potential value is coloured by its own value and nothing else: 85 and above hot, 75 warm, 60 tepid, 40 mild, below 40 cold. A band is coloured by its band: Top 10 % hot, Top 25 % warm, Top 50 % mild, Bas 50 % cold. The verdict strip mixes its band colour into the paper at 11% (24% at night) and rules its edges at 26% (42% at night). With no band yet (pending or judging), the strip is tinted and ruled with Strong Rule instead of a thermal colour.

**The Blue Instrument Rule.** Action Blue carries interaction and the forecast's own instruments: confidence, route progress, calibration. It never encodes potential, and a thermal colour never marks an action.

**The One Sun Rule.** The only non-data use of a thermal hue is Warm as the brand's sun: the brand mark, the active nav icon, text selection (Warm at 35%), and the final station of the onboarding route, « Le bulletin avant publication ». Every other thermal colour on screen is a score, a band, a trend front, or a warning marker.

**The Night Bulletin Rule.** Every colour token is redefined under `prefers-color-scheme: dark`; night is deep blue, never black. Components reference `var(--token)`, except deliberate fixed values on the always-dark shell (white text, the rgba(255, 255, 255, 0.14) active wash, status dots #5BC48F ready / #FF8A80 error) and the brand mark's #0D2240 « A ». Ticks drawn on Action Blue or Verified Green use a token (Action Ink), never #FFFFFF.

## Typography

**Display Font:** Fira Sans Condensed (with Fira Sans, Arial Narrow, sans-serif)
**Body Font:** Fira Sans (with Segoe UI, system-ui, sans-serif)
**Label/Mono Font:** Fira Sans Condensed for labels and readings; the system has no monospace.

**Character:** Fira's humanist forms in two cuts: the condensed cut reads as the figures printed on a bulletin, the regular cut as the forecaster's prose. Both load from Google Fonts (Fira Sans 400/500/600/700 plus italic 400; Condensed 500/600/700).

### Hierarchy
- **Display** (700, 68px, 0.9, -0.02em, tabular): the reading in the verdict's thermometer block. 48px at 640px and below. One per screen.
- **Headline** (Condensed 700, 34px, 1.08): the band title, « Top 25 % de ta niche ». 26px on phones.
- **Title, page** (600, 28px, 1.2, -0.012em, balanced): page `h1`. 24px on phones.
- **Title, flow** (600, 25px, 1.25, -0.01em, balanced): the idea itself, heading the result screen. 22px on phones.
- **Title, script** (600, 22px, 1.3): the script's own title. Card titles step down from here: angle titles 18px, station and radar-source titles 16px, all 600 at 1.3.
- **Title, section** (600, 19px, 1.3): section heads such as « Comment Amorce prévoit », the running-forecast title and empty-state headings.
- **Script** (400, 18px, 1.62, max 66ch): the script to publish. 16.5px on phones; X threads set each tweet at 16.5px/1.55 within 64ch. The verdict sentence is 17px/1.45 within 52ch and the page lede 16px/1.55 within 64ch.
- **Body** (400, 15px, 1.5): interface text. Meta lines run 12.5–14.5px.
- **Field** (400, 15px, 1.45): text inputs, textareas and selects; the idea field is set at 18px/1.5.
- **Label** (Condensed 600, 12px, 1.2, 0.08em, uppercase, Mist Ink on paper, Slate Ink on the band-tinted verdict strip): names the thing directly next to it — form field labels, in-panel data labels (« Échelle de potentiel », « Indice de confiance », « Prévu · relevé »), the side panel's group heads (« Facteurs », « 3 améliorations », 12.5px in Slate Ink), the shell's « Récents » (Shell Ink Dim #8EA8CA). Small uppercase tags (10.5–11.5px, 0.06–0.08em) reuse the same voice: « Exemple », match badges, « Priorité », « Réécrit ».
- **Numeral** (Condensed 700, 15px, 1, tabular): thermal chips (13px in the small chip). Clocks use Condensed 600 at 30px (running forecast) and 18px (judging).

### Named Rules
**The Condensed Reading Rule.** Fira Sans Condensed sets readings: scores, thermal chips, band titles, clocks, scale labels, labels. Fira Sans sets prose, headings and meta figures. Scores, thermal chips, clocks and tweet numbers carry tabular figures in the condensed cut; the Fira Sans meta figures that change or line up (calibration %, tweet length, script measure, signal counts, the stat and median inputs) take tabular-nums too; the confidence and route « n/5 », the improvement counters, dates and view counts are plain figures.

**The Script First Rule.** The script to publish is the largest running text on the screen (18px/1.62, at most 66ch); the verdict sentence (17px), the lede (16px) and interface text (15px) step down from it.

**The Label Names Its Neighbour Rule.** The uppercase condensed label names the field, value or group directly beside or below it. It never sits above a heading to introduce it.

French setting: `q` renders « guillemets » with non-breaking spaces, headings keep a non-breaking space before « ? », and numbers format as fr-FR.

## Layout

An app frame, not a page. A 236px map-blue sidebar runs the full viewport height (sticky) and the content column takes the rest, with 32px top padding, a fluid side gutter (`clamp(20px, 3.4vw, 44px)`) and 96px at the bottom. Views centre at a 1240px maximum; the brief and settings forms hold to 920px, the onboarding explanation to 1080px.

The result screen stacks: the flow head (idea title and actions on the first row, meta line and route on the second), the platform tabs, then the bulletin as one full-width sheet. Inside it, the verdict strip is a three-column grid (124px reading, fluid verdict, 384px meta) with 28px gaps and 22px × 28px padding; below it the body splits into the script (fluid) and the diagnostic side panel (380px).

Spacing is written as literals in the CSS (no custom properties) but recurs on the rhythm the frontmatter names: tight (8px) inside clusters of controls, 10px to stack (16px) between rows and fields, panel (28px) between panel columns and as panel side padding, the fluid gutter at the sides, and 56px before a new section on the brief page.

Responsive behaviour, in three steps:
- **1180px and below:** the reading column narrows to 112px and the verdict's meta column drops under the reading and verdict into two columns (1.3fr / 1fr); the side panel narrows to 330px; the running-forecast side column stacks below.
- **960px and below:** the shell becomes a sticky top bar (brand mark, nav, status dot): the brand name, the status text and recent items hide, and nav links shrink to 38px tall with 11px side padding; the content column's top padding drops to 24px; the bulletin body, angle grid and onboarding stations reflow to one or two columns; the flow head stacks route, title, meta, actions; the sticky action bar spans the width under the top bar.
- **640px and below:** nav goes icon-only; the verdict becomes 88px reading plus verdict (88px tall reading, 48px numeral, 26px band title, 15.5px verdict sentence) with 18px padding and 16px gaps; the script and the side panel pad 18px; platform tabs tighten to 14px text with 0 10px 0 12px padding and drop their hint; the sticky bar drops its score switch and button labels; the route collapses to bare stations with the current step named beside it; onboarding stations run down a vertical line.

### Named Rules
**The Route Rule.** Step progress is a route: a 2px Strong Rule line threading 12–14px station dots. Completed dots and segments fill Action Blue and the current station wears a 4px Action Blue halo at 18%. On the onboarding route the final station is Warm and the first segment is drawn as a warm front. Steps are never drawn as a progress bar or a ring.

## Elevation & Depth

Flat tonal layering with a hairline shadow. Depth comes from the sky-to-paper ramp (Cold Sky ground, Bulletin Paper panels, Paper Shade for inner panels and side columns, Paper Wash for wells) and from 1px rules. Shadows always carry a vertical offset and a soft blur; at night they switch to black at higher opacity (hairline `0 1px 2px rgba(0, 0, 0, 0.35)`, lift `0 14px 30px -16px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.3)`, sticky `0 14px 34px -18px rgba(0, 0, 0, 0.8)`).

### Shadow Vocabulary
- **Hairline rest** (`box-shadow: 0 1px 2px rgba(13, 34, 64, 0.06), 0 1px 1px rgba(13, 34, 64, 0.04)`): cards, the bulletin, angle cards, history entries.
- **Lift** (`box-shadow: 0 10px 28px -14px rgba(13, 34, 64, 0.28), 0 2px 6px rgba(13, 34, 64, 0.06)`): an angle card under a fine pointer's hover (with a 2px rise), and the toast.
- **Sticky** (`box-shadow: 0 12px 30px -18px rgba(13, 34, 64, 0.45)`): the sticky action bar once it has engaged.
- **Focus ring** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--act) 22%, transparent)`): text inputs, the select and the median and stat inputs on focus; the Radar search field instead rings its whole card on focus-within at 20%; every other control gets a 2px Action Blue outline at 2px offset.

### Named Rules
**The Flat Paper Rule.** Surfaces rest flat with the hairline shadow. Lift is a response to hover or a transient message, never a resting state. The one translucent surface is the sticky action bar (paper at 92% with `saturate(1.4) blur(10px)`), which needs it to stay legible over scrolled content.

## Shapes

Gently rounded instrument shapes on a 1px line. Large containers (cards, the bulletin, the reading block) take 14px; alerts, the large button and the toast 10px; buttons and inputs 9px; shell items and the brand mark 8px; thermal chips and skeletons 6px; small tags 4–5px. Pills (999px) are for platform chips, suggestion chips and the trend pill in the flow head. Every dot is a true circle: status, stations, confidence, the observed-reading ring, the numbered improvement counters. Borders are always 1px; the band scale's segments are 8px bars at 2px radius with 3px gaps.

### Named Rules
**The Attached Tab Rule.** The bulletin's top-left corner is square (0 14px 14px 14px) so the selected platform tab, with 11px top corners, no bottom border and a 1px overlap, reads as one sheet with it.

**The Dashed Provisional Rule.** A dashed 1px Strong Rule border marks what is not measured yet: the « relevé à venir » link and the « Exemple » tag on demonstration data.

## Components

### Buttons
Compact and plain-spoken: the label names the action.
- **Shape:** gently rounded (9px), 40px tall, 16px side padding, 8px gap to a 17px stroke icon. Large variant 48px tall, 22px padding, 10px radius, 15.5px text.
- **Primary:** Action Blue fill and border, Action Ink text, weight 600. Hover deepens to Action Blue Deep.
- **Secondary:** paper fill, 1px Chart Rule border, Deep Ink text, weight 500 at 14.5px. Hover takes a Strong Rule border and Paper Shade fill.
- **Quiet:** transparent, Slate Ink text; hover Paper Wash fill and Deep Ink text (flow-head actions such as « Nouvelle idée »).
- **Press / Disabled / Busy:** presses scale to 0.98 over 140ms (off under reduced motion); disabled sits at 55% opacity; a busy button stops taking pointer events and spins its icon (900ms, linear).
- **Réécrire:** the side panel's rewrite button runs full width at 46px.

### Chips
- **Platform toggle:** 42px pill, paper fill, 1px Chart Rule border, Slate Ink 500, platform icon and a 16px check circle (inset Strong Rule ring). Checked: Action Blue border, Action Wash fill, Deep Ink text, the circle filled Action Blue with an Action Ink tick. Keyboard focus outlines the pill.
- **Suggestion chip:** 32px pill, paper, Chart Rule border, 13.5px; hover turns border and text Action Blue.
- **Tags:** the angle tag (« Angle actuel », « Le plus porté ») is condensed 11px uppercase Action Blue on Action Wash (4px); match badges pair each status ink with its wash (5px).

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Bulletin Paper on the sky. Nothing inside a card is a card: trend fronts and tweets sit on the parent surface as rows divided by a 1px Faint Rule, with no fill, border, radius or shadow of their own.
- **Shadow Strategy:** hairline rest; lift on hover only for interactive angle cards (see Elevation & Depth).
- **Border:** 1px Chart Rule.
- **Internal Padding:** 18–28px (brief and settings 24px, trend panel 20px × 24px, running forecast 26px × 28px, Radar source cards 18px × 20px, system card 22px × 24px); the empty state uses 40px × 28px and the search card a tight 8px 8px 8px 16px.

### Inputs / Fields
- **Style:** 1px Chart Rule stroke, paper fill, 9px radius, 10px × 12px padding, 15px/1.45. The label sits above with a 7px gap; placeholders in Mist Ink. The idea field is set larger (18px, 104px tall).
- **Focus:** border turns Action Blue with a 3px Action Blue ring at 22%; the search field rings its whole card on focus-within (20%).
- **Error / Disabled:** an invalid field takes an Alert Red border and a 13.5px Alert Red message below, naming the fix (« Écris ton idée pour lancer la prévision. »). Help text is 13px Mist Ink. Selects draw their own chevron from two 1.75px Slate Ink strokes.

### Navigation
- **Shell:** the map-blue sidebar (22px top, 14px sides, 18px bottom padding; 28px between groups). The brand mark is a 30px Warm square at 8px radius holding a condensed 700 17px « A » in a fixed #0D2240 (it does not follow the night Thermal Ink #06101F), beside the 19px/600 name. Nav links are 42px, 8px radius, Shell Ink 500 with 18px stroke icons; hover takes the Shell Highlight and white text; the current page takes white at 14%, white text and a Warm icon. Recent forecasts list at 13.5px; a status line closes the column with an 8px dot (green ready, Mild warning, red error).
- **Mobile:** at 960px the shell becomes a sticky top bar and recents hide; at 640px nav links drop their text.
- **Platform tabs:** 48px tabs (platform icon, name, small thermal chip), Slate Ink 500 at rest, half-paper hover. The selected tab is paper, Deep Ink 600, 49px tall and joins the bulletin (The Attached Tab Rule). Arrow keys, Home and End move between tabs.
- **Sticky action bar:** slides down from the top (260ms) once the bulletin's head scrolls away, carrying the idea title, a per-platform score switch (small thermal chips) and « Copier » and « Réécrire »; under reduced motion it fades instead.

### Thermal Chip
The smallest reading. 26px tall, at least 34px wide, 6px radius, condensed 700 15px tabular figure on a fill equal to the value's own heat, in Thermal Ink (Hot Ink on hot). The small chip is 22px tall, 13px, 5px radius. With no score yet it is hollow: transparent, an inset Strong Rule ring and « — » in Mist Ink. Bars that show a value (factor bars, angle fit bars) are filled with the same heat.

### Bulletin Verdict Band
The signature. A full-width strip tinted with its band (The Thermal Scale Rule), in three parts:
- **Reading block:** 124px × 116px at 14px radius, filled with the score's heat; the Display numeral over « / 100 » in condensed 600 12px in the block's own ink (Thermal Ink, Hot Ink on hot). Pending, it turns to Paper Wash with an inset Chart Rule ring, a « — » and « à évaluer » or « en cours » in Slate Ink.
- **Verdict:** the band title (Headline) over the verdict sentence (17px Slate Ink; its lead clause, up to the first « : », « ; » or dash, in Deep Ink 500 when that clause runs 8 to 90 characters).
- **Meta column** (left rule in the band at 26%, 28px padding, 16px gaps): the « Échelle de potentiel » — four 8px segments in the band colours at 50% opacity, the current one at full, a Deep Ink needle (triangle plus 2px stem) above it, the observed reading as a hollow ring on the track, condensed 12px labels in Slate Ink with the current band in Deep Ink 700; the « Indice de confiance »; and the « Prévu · relevé » row — predicted band, a 14px arrow stroke icon in Mist Ink, then the observed band with its match badge, or a dashed « relevé à venir » link in Slate Ink to the history.
- **Below the strip:** the script on the left (22px × 32px × 28px × 28px padding) and the diagnostic side panel on the right (Paper Shade, Faint Rule left border): factor rows 32px tall (name, 5px heat bar, small thermal chip) with the lowest-scoring factor (first on ties) raised on paper with a « Priorité » tag, only when that score is below 80; its note stays visible as one clamped line; then three numbered improvements, then « Réécrire ».
- **Motion, « le bulletin tombe »:** once per forecast the reading drops from 12px above at 96% scale (460ms) and counts up from 0 (900ms); band title and verdict rise in at 180ms and 260ms; the needle slides to its band (720ms, ease-in-out, from 240ms); confidence dots pop in from 480ms, 90ms apart; factor bars grow from the left (560ms, from 320ms, 60ms apart); improvements rise from 640ms; the tab chips pop from 200ms. Under reduced motion the whole strip simply fades from 40% to full over 200ms. A rewrite blurs the script (2px, 50% opacity) while it works, then clears over 260ms while the numeral counts from the old score to the new one; under reduced motion the script only fades from 50% to full over 200ms, with no count-up.

### Confidence Index
Five 10px dots, 4px apart, each an inset 1.5px Action Blue ring, filled Action Blue up to the level, followed by « n/5 » and the level word. « faible » fills 2, « moyenne » 3, « haute » 4; the fifth dot is never filled.

### Calibration Meter
The history's measure of how often forecasts held: ten 10px × 26px bars at 3px radius with 3px gaps, Paper Wash when empty and Action Blue when filled. It fills round(adjacent % / 10) bars, the share of readings within one band of the forecast, and none until a first reading exists.

### Warm-Front Glyph
The cartographic symbol for a warm front: a 34px × 14px line in Hot (1.7px, round caps) carrying three filled Hot semicircles; 24px × 10px inside live signals. It marks retained trends and live signals: the trend fronts, the live signals while a forecast runs, and the trend pill in the result header. Raw signal lists and Radar results are plain rows without it.

### Route Stepper
The forecast's itinerary (The Route Rule) at the right of the flow head, on the Cold Sky ground: five stations, Idée · Tendances · Angle · Scripts · Prévision, 76px per station, 12px dots, 12.5px labels in Slate Ink (6.84:1 on Cold Sky) and Deep Ink 600 for the current step. The current station is the first not done (Prévision once all are done). Pending dots are Cold Sky with a 2px Strong Rule ring; the current pending dot is paper with a 2px Action Blue ring plus the 4px 18% halo; done dots fill Action Blue, and a current done dot keeps the halo. On phones the stations shrink to 26px, their labels move off-screen for assistive tech only, and the current step is named beside the line as « n/5 · Station » (13px Deep Ink 600). On the onboarding route the dots are 14px Cold Sky with a 2.5px Action Blue ring, the last filled Warm; its first segment is a 2px Hot line carrying 4px Hot semicircles every 14px, a plain 2px Hot line at 640px and below. Running stages use the same grammar vertically: 18px dots, Verified Green with a tick when done, an Action Blue ring with a centre dot while active.

### Feedback
- **Alert:** Alert Red on its wash, a 1px Alert Red border at 30%, 10px radius, icon at left, title in 600 and a recovery action below.
- **Notice:** Rust Ink on its wash with a Tepid border at 40%, 10px radius.
- **Toast:** Deep Ink fill, paper text, 10px radius, Lift shadow, centred at the bottom; it rises 12px into place over 200ms.
- **Skeletons:** Paper Wash bars at 6px radius, in the shape of the content they replace.

## Do's and Don'ts

### Do:
- **Do** colour every potential number by its own value with the thermal thresholds (85 hot, 75 warm, 60 tepid, 40 mild, below cold) and every band by its band (Top 10 % hot, Top 25 % warm, Top 50 % mild, Bas 50 % cold).
- **Do** set text on cold, mild, tepid and warm fills in Thermal Ink, and on hot in Hot Ink.
- **Do** show confidence as five Action Blue dots: faible 2/5, moyenne 3/5, haute 4/5.
- **Do** pair every forecast with its observed reading: a hollow ring on the band scale once entered, a dashed « relevé à venir » until then.
- **Do** mark retained trends and live signals with the warm-front glyph in Hot.
- **Do** draw step progress as a route line with stations (2px line, 12–14px dots, Action Blue when done).
- **Do** use `var(--token)` for every colour so the night bulletin follows the device; the shell's fixed whites and status dots and the brand mark's « A » are the only literals, and a tick on Action Blue or Verified Green takes Action Ink, never #FFFFFF.
- **Do** set every reading in Fira Sans Condensed with tabular figures on scores, chips and clocks, and give meta figures that change or line up (calibration %, tweet length, script measure, signal counts) tabular-nums.
- **Do** keep Mist Ink (#5C7392) for text on Bulletin Paper and Paper Shade only (4.86:1, 4.56:1); on Cold Sky (4.23:1), Paper Wash (4.35:1) and the band-tinted verdict strip (4.13:1 on Top 10 %) use Slate Ink.
- **Do** keep « le bulletin tombe » as the one authored motion moment, and give reduced motion a short fade rather than nothing.

### Don't:
- **Don't** paint a score, band or bar with a colour its value did not earn, and don't use a thermal hue on chrome beyond Warm's brand uses and the warning markers (the Mild status dot, Tepid flag bullets and the Tepid notice border).
- **Don't** fill the fifth confidence dot or present a score as a promise of views.
- **Don't** reach for violet gradients, sparkles or a grey gauge dial: the instruments are the thermometer, the band scale and the front.
- **Don't** put an uppercase label above a heading as a kicker or eyebrow; a heading stands on its own.
- **Don't** render step progress as a progress bar or a ring.
- **Don't** use Unicode characters or emoji as icons; interface icons are 24px-grid SVG strokes at 1.75px with round caps and joins (ticks inside 16–18px check circles at 3), and the cartographic warm-front glyph is the one authored symbol on its own 34 × 14 grid.
- **Don't** make night black; it is deep blue.
- **Don't** give a surface a resting lift or a hard offset shadow; depth is tonal, shadows are offset and soft.
