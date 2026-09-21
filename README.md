# Fully Logistics website

Marketing site for a fulfillment and contract logistics company. Five pages, plain HTML, CSS and JavaScript, no framework and no runtime dependencies.

| Page | Built file (in `dist/`) |
| --- | --- |
| Home | `index.html` |
| Solutions: Fulfillment (webshops) | `solutions/fulfillment.html` |
| Solutions: Manufacturers | `solutions/manufacturers.html` |
| About | `about.html` |
| Contact | `contact.html` |

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
src/pages/           page content (front matter holds title, description, nav state)
src/partials/        header, footer, brand mark, call-to-action panel
src/data/site.json   contact details, footer text, default call-to-action copy
src/data/faq.json    FAQ questions and answers (also emitted as schema.org FAQPage data)
src/icons/           Phosphor "bold" icon subset, inlined at build time
src/images.json      photo manifest (sizes and Unsplash source)
assets/css/site.css  all styling; colour, type and spacing tokens are at the top
assets/js/site.js    theme toggle, menus, reveal, counters, tabs, form
assets/              also holds the images, fonts and favicon; copied into dist/ as they are
robots.txt           copied into dist/ as it is
dist/                the finished site (generated, not committed, never edit by hand)
wrangler.jsonc       Cloudflare deployment settings
```

## Replace before launch

Everything below is sample content written to make the design realistic. None of it comes from a real company.

- **Proof section (home) and facility figures (About):** percentages, parcel counts, floor space, dock doors, staff numbers and the two client quotes with their names.
- **Commercial claims:** 2 pm cut-off, "no minimum volume", "30 days' notice", three-month start period, 12 hour goods-in time, "first order in about two weeks".
- **Platform and carrier lists:** Shopify, WooCommerce, Shoprenter, UNAS, Magento, GLS, DPD, Foxpost, MPL, DHL. Keep only what you actually integrate with.
- **Contact details** in `src/data/site.json`: the address, phone number and the `.example` email address are placeholders. The contact form falls back to that email address, so messages go nowhere until you replace it.
- **Working day timetable** on About (06:00 to 17:30).

Search the source for `SAMPLE CONTENT` to find the marked blocks.

## Contact form

The form validates inline. To make it send, set `data-endpoint` on the `<form>` in `src/pages/contact.html` to a form service URL (Formspree, Netlify Forms, your own API) and rebuild. Until then it opens the visitor's email app with the request pre-filled, so nothing is ever reported as "sent" when it was not.

## SEO

Set `"url"` in `src/data/site.json` (for example `https://www.example.com`) and rebuild to add canonical and Open Graph URLs. `assets/img/og.jpg` is the social sharing image.

## Design notes

- **Direction:** industrial and warehouse. Concrete greys, one hi-vis yellow accent (`#E8BE3C`), hazard-stripe and floor-tape details, hard edges everywhere (no rounded corners), signage-weight Archivo type with Geist Mono for small labels.
- **Themes:** light and dark, following the visitor's system setting, with a manual toggle in the header that remembers the choice. Both are defined once with `light-dark()` tokens.
- **Motion:** the hero photo lifts like a dock door, content reveals on scroll, statistics count up once. All of it is switched off for visitors who prefer reduced motion, and every page works without JavaScript.
- **Fonts** are self-hosted (`assets/fonts/`), so no request goes to Google. **Images** are WebP at three widths with `srcset`.
- **Checked:** no horizontal overflow at 360, 390, 820, 1280 and 1440 px wide; axe-core reports zero WCAG 2.2 AA violations on all pages in both themes.

## Credits and licences

Photography is from Unsplash under the Unsplash licence. See `CREDITS.md` for the photographer of every image. Icons are Phosphor Icons (MIT). Archivo and Geist Mono are licensed under the SIL Open Font License.
