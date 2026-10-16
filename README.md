# Fully Logistics website

Marketing site for a fulfillment and contract logistics company. Five pages in seven languages, plain HTML, CSS and JavaScript, no framework and no runtime dependencies.

| Page | Built file (in `dist/`) |
| --- | --- |
| Home | `index.html` |
| Solutions: Fulfillment (webshops) | `solutions/fulfillment.html` |
| Solutions: Manufacturers | `solutions/manufacturers.html` |
| About | `about.html` |
| Contact | `contact.html` |

Hungarian is the default language and lives at the root of the site. Every other language has its own folder with the same file names:

| Language | Folder | Text |
| --- | --- | --- |
| Magyar (default) | `/` | `src/i18n/hu.json` |
| Deutsch | `/de/` | `src/i18n/de.json` |
| English | `/en/` | `src/i18n/en.json` |
| Español | `/es/` | `src/i18n/es.json` |
| Français | `/fr/` | `src/i18n/fr.json` |
| Română | `/ro/` | `src/i18n/ro.json` |
| Polski | `/pl/` | `src/i18n/pl.json` |

So the German About page is `/de/about.html`. A language switcher in the header (in the menu on phones, and as a row of links in the footer) leads to the same page in the chosen language.

## Run it

The pages are generated from `src/` into `dist/`. Build, then serve that folder (opening `dist/index.html` straight from disk also works, but logs a harmless font-preload notice in the console):

```bash
node build.mjs
python -m http.server 4173 --directory dist
```

Then visit http://localhost:4173. `npm run build` and `npm run serve` do the same. The `screenshots/` folder (local review captures, kept out of git) and `.claude/launch.json` (a preview shortcut for Claude Code) are not part of the site.

## Deploy

Only `dist/` is ever published. It is rebuilt from scratch on every build and is not committed to git.

**Cloudflare (Workers with static assets).** `wrangler.jsonc` already points at `dist/`. In the project's build settings use:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Keep the assets directory on `dist/`, never the repository root. The root contains `src/` and `.git`, and any `node_modules` in it would break the deploy, because Cloudflare rejects files over 25 MiB.

**Any other static host** (Netlify, Vercel, GitHub Pages, cPanel): run `node build.mjs` and upload the contents of `dist/`.

## Edit it

Edit the sources, then rebuild with `node build.mjs`. The header, footer, icons, responsive images and FAQ live in one place and stay identical on every page. The build needs only Node 18+. It also lints the output: every link, image and anchor must resolve inside `dist/`, no em or en dashes may appear in the markup, and no deployed file may exceed 25 MiB.

```
src/pages/           page structure; text is referenced as {{t.home.hero.lead}} and so on
src/i18n/<lang>.json all visible text of one language: pages, titles and descriptions, image alt
                     texts, FAQ (also emitted as schema.org FAQPage data), form and script messages
src/partials/        header, footer, brand mark, call-to-action panel
src/data/site.json   site name, URL, language list, contact details (address, phone, email)
src/icons/           Phosphor "bold" icon subset, inlined at build time
src/images.json      photo manifest (sizes and Unsplash source)
assets/css/site.css  all styling; colour, type and spacing tokens are at the top
assets/js/site.js    theme toggle, menus, reveal, counters, tabs, form
assets/              also holds the images, fonts and favicon; copied into dist/ as they are
robots.txt           copied into dist/ as it is
dist/                the finished site (generated, not committed, never edit by hand)
wrangler.jsonc       Cloudflare deployment settings
```

## Languages

**Changing text.** Edit the string in every language file that needs it, then rebuild. All seven files have the same keys in the same order, so the German version of a Hungarian string sits at the same place in `de.json`. Write characters as they are (á, ő, ș, ł, „…”), never as HTML entities, and write a non-breaking space as `\u00a0` (for example between a number and its unit). A few strings carry markup, such as the highlighted word in the home headline: keep the tags.

**The build checks the translations.** Every language file must have exactly the keys, list lengths, HTML tags and `{placeholders}` of `hu.json`, and may not use HTML entities, ASCII double quotes or em and en dashes. A missing or extra string fails the build with the exact key, so no page can go out half translated.

**Adding a language.** Copy `src/i18n/hu.json` to `src/i18n/<code>.json`, translate the values (set `meta.name` to the language's own name and `meta.locale`, for example `it_IT`), add the code to `languages` in `src/data/site.json` and rebuild. The first code in that list is the default language served at the root.

**Numbers** on the statistics are formatted for each language at build time (`98,7%`, `41 860`, `41.860`), and the count-up animation uses the same format. The unit after a figure comes from `units` in the language file.

## Replace before launch

Everything below is sample content written to make the design realistic. None of it comes from a real company.

- **Translations:** the German, English, Spanish, French, Romanian and Polish texts were drafted with AI from the same source. Have a native speaker proofread each language before launch, in particular headlines, the price terms and the contact form.

- **Proof section (home) and facility figures (About):** percentages, parcel counts, floor space, dock doors, staff numbers and the two client quotes with their names.
- **Commercial claims:** 2 pm cut-off, "no minimum volume", "30 days' notice", three-month start period, 12 hour goods-in time, "first order in about two weeks".
- **Platform and carrier lists:** Shopify, WooCommerce, Shoprenter, UNAS, Magento, GLS, DPD, Foxpost, MPL, DHL. Keep only what you actually integrate with.
- **Contact details** in `src/data/site.json`: the address, phone number and the `.example` email address are placeholders. The contact form falls back to that email address, so messages go nowhere until you replace it. The opening hours and the country name are text, so they live in `common.hours` and `common.country` of each language file.
- **Working day timetable** on About (06:00 to 17:30).

Search the source for `SAMPLE CONTENT` to find the marked blocks.

## Contact form

The form validates inline. To make it send, set `data-endpoint` on the `<form>` in `src/pages/contact.html` to a form service URL (Formspree, Netlify Forms, your own API) and rebuild. Until then it opens the visitor's email app with the request pre-filled, so nothing is ever reported as "sent" when it was not.

## SEO

Set `"url"` in `src/data/site.json` (for example `https://www.example.com`) and rebuild to add canonical and Open Graph URLs, plus `hreflang` links that tell search engines which page is the same content in which language (Hungarian is also the `x-default`). Every page sets its `lang` attribute and Open Graph locale. `assets/img/og.jpg` is the social sharing image.

## Design notes

- **Direction:** industrial and warehouse. Concrete greys, one hi-vis yellow accent (`#E8BE3C`), hazard-stripe and floor-tape details, hard edges everywhere (no rounded corners), signage-weight Archivo type with Geist Mono for small labels.
- **Themes:** light and dark, following the visitor's system setting, with a manual toggle in the header that remembers the choice. Both are defined once with `light-dark()` tokens.
- **Motion:** the hero photo lifts like a dock door, content reveals on scroll, statistics count up once. All of it is switched off for visitors who prefer reduced motion, and every page works without JavaScript.
- **Fonts** are self-hosted (`assets/fonts/`), so no request goes to Google. **Images** are WebP at three widths with `srcset`.
- **Checked:** all 35 pages (five pages in seven languages) have no horizontal overflow and no header collisions at 360, 390, 640, 820, 900, 1024, 1280 and 1440 px wide; axe-core reports zero WCAG 2.2 AA violations on all of them in both themes.

## Credits and licences

Photography is from Unsplash under the Unsplash licence. See `CREDITS.md` for the photographer of every image. Icons are Phosphor Icons (MIT). Archivo and Geist Mono are licensed under the SIL Open Font License.
