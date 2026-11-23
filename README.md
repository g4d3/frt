# Travel exposure history – fever in the returning traveller

A single-page website for clinicians. Drop a pin on a map for each place a traveller stayed, add dates and exposures (mosquitoes, ticks, dogs, cattle, fresh water, funerals…), and download a plain-text `.txt` summary listing the **possible** infections for those places and exposures, with incubation periods checked against the fever-onset date.

It deliberately does **not** use symptoms. It is the first step of the fever-in-the-returning-traveller work-up, not a diagnostic engine.

* No server and no database: the site is static HTML, CSS and JavaScript.
* No patient data leaves the browser. Nothing is stored; closing the tab clears it.
* All clinical content lives in five CSV files in `data/` that you can edit in Excel or directly on GitHub.

---

## 1. Folder layout

```
index.html            the page
css/style.css         styling
js/engine.js          matching + report logic (no DOM; also runs in Node for testing)
js/app.js             map, form, download
data/countries.csv    country → region, subregion, tags
data/exposures.csv    the exposure checklist (labels, groups, question prompts)
data/pathogens.csv    pathogen names, incubation ranges, HCID flags, notes
data/exposure_map.csv the rules: where + exposure → pathogen
data/alerts.csv       current outbreaks (hand-maintained)
data/areas.geojson    mapped sub-national risk areas (shapes you can redraw)
data/hcid_risk.csv    HCIDs by country/area (UKHSA)
data/version.txt      date of the last data update (shown in every report)
```

## 2. Try it on your own computer

The page loads the CSV files with `fetch`, which browsers block for files opened directly from disk. Start a tiny local web server in the folder instead:

```bash
cd frt-exposure-tool
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (On Windows without Python: install the free "Live Server" extension in VS Code and click *Go Live*.)

## 3. Put it live (free) with GitHub Pages – no command line needed

1. Create a free account at <https://github.com>.
2. Click **+ → New repository**. Name it e.g. `travel-exposure`. Choose **Public** (GitHub Pages is free for public repositories). Tick *Add a README* is not needed. Click **Create repository**.
3. On the empty repository page click **uploading an existing file**. Unzip `frt-exposure-tool.zip` on your computer, open the folder, select **everything inside it** (index.html, css, js, data, README.md, .nojekyll) and drag it into the browser. Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment* choose **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, then **Save**.
5. After about a minute the page shows your address: `https://<your-username>.github.io/travel-exposure/`. That is your live site.

Every later change you commit (for example to a CSV file) is live again within a minute or two.

**Alternatives:** Netlify Drop (<https://app.netlify.com/drop>) – drag the unzipped folder onto the page for an instant URL. Or ask your trust's IT/web team to host the folder on an intranet server: it is just static files.

> **NHS use:** if this becomes part of routine clinical care in a trust, talk to your Clinical Safety Officer about DCB0129/DCB0160. Because no patient data is transmitted or stored, information-governance exposure is minimal, but the clinical content still needs local sign-off.

## 4. Updating the data

You can edit any CSV on GitHub: open the file, click the **pencil** icon, change it, then **Commit changes**. Or download it, edit it in Excel and save it as **CSV UTF-8**, then upload it over the old one.

After any change:

* Update `data/version.txt` to today's date (it is printed on every report).
* Open the site's **Data** tab. Any broken reference (a misspelt pathogen or exposure id) is listed there in red. Pick a country to see exactly which rules apply to it, or download the full expanded *country → exposure → pathogen* table to review it in Excel.

Lines starting with `#` are comments and are ignored.

### How a rule works (`exposure_map.csv`)

| where | except | exposure | pathogen | note | source |
|---|---|---|---|---|---|
| `schisto` | | `freshwater` | `katayama` | | BIA2025 T2 |
| `GLOBAL` | `rabies_free` | `dog` | `rabies` | | NEJM2017 T1 |
| `KEN;TZA` | | `tick` | `atbf` | Game parks | NEJM2017 |

`where` and `except` take a `;`-separated list. Each item can be:

* `GLOBAL` – everywhere
* an ISO3 country code – `KEN`
* a region or subregion from `countries.csv` – `sub-saharan-africa`, `west-africa`, `southeast-asia`…
* a tag from the `tags` column of `countries.csv` – `malaria_high`, `lassa`, `cchf`, `aedes`…

The special exposure `any` means "applies to every stay in that country, whatever was ticked" (used for malaria, enteric fever in South Asia, Lassa/CCHF background risk, etc.).

**To add a country to an existing risk** (e.g. a new country reporting Oropouche), add the tag to that country's `tags` cell in `countries.csv`: `aedes; oropouche`.
**To add a new pathogen:** add a row to `pathogens.csv` (unique `id`), then add rules that use it.
**To add a new exposure to the checklist:** add a row to `exposures.csv`, then add rules that use it.

### Sub-national risk areas (`areas.geojson` + `area_tags`)

By default a risk applies to the whole country. For risks that only occur in **part** of a country, two things work together:

1. In `countries.csv`, put the tag in the country's **`area_tags`** column (as well as in `tags`). Example: USA has `cocci; histo; lyme; rmsf; plague; tbrf; aedes`.
2. In `data/areas.geojson`, draw a shape with that tag. A pin inside the shape picks up the tag; a pin outside does not.

What the report then does:

* **Pin inside the area:** the risk is listed normally, and the report names the area the pin is in.
* **Pin outside the area:** the risk is moved to a section called *"Not at this pin – limited to other parts of <country>"*, so it is never silently dropped.
* **No pin (stop added without the map):** the risk is listed but marked **AREA NOT ASSESSED** (dashed chip on screen).

Areas drawn so far (rough outlines, 22 Nov 2026 – please check them against the source maps):

| Area | Tags | Country |
|---|---|---|
| SW USA & northern Mexico – valley fever | cocci | USA, MEX |
| Ohio & Mississippi valleys | histo | USA |
| North-east & upper Midwest | lyme | USA |
| South-central/south-east USA, eastern Arizona | rmsf | USA |
| Western USA | plague; tbrf | USA |
| Florida, south Texas, Hawaii | aedes (dengue etc.) | USA |
| Chiapas; Sierra Madre Occidental | malaria_risk | MEX |
| Kruger / lowveld / NE KwaZulu-Natal | malaria_risk | ZAF |
| Northern Namibia & northern Botswana | malaria_risk | NAM, BWA |
| Thai border forest provinces | malaria_risk; knowlesi | THA |
| Eastern & southern China | scrub_typhus | CHN |
| Brazilian (Legal) Amazon | malaria_risk | BRA |
| Peruvian Amazon | malaria_risk | PER |
| Northern & central Argentina; NE Argentina | aedes; yellow_fever | ARG |
| Southern France & Corsica; Spain ex. Atlantic north; Italy from Liguria south | visceral_leish; sandfly_fever; msf | FRA, ESP, ITA |
| Tropical northern Australia | aedes; melioidosis; scrub_typhus; je | AUS |

**To redraw or add an area** (no coding):

1. Go to <https://geojson.io>. Open `data/areas.geojson` (*Open → File*), or start fresh.
2. Use the polygon tool to draw or reshape the outline. Click the shape and set these properties:
   `id` (unique, no spaces), `name`, `countries` (ISO3 codes, `;`-separated), `tags` (`;`-separated tags from `countries.csv`), `note`, `source`.
3. *Save → GeoJSON*, and upload the file over `data/areas.geojson` on GitHub.
4. If the tag should now be area-limited in that country, add it to the country's `area_tags` in `countries.csv`.
5. On the site, drop pins inside and outside the shape and check the "Pin is inside…" line on the stop card.

A shape may cross borders (the valley-fever zone covers Arizona and Sonora). Only countries that list the tag in `area_tags` are restricted by it; elsewhere the tag simply adds risk where the pin falls.

### High consequence infectious diseases (`hcid_risk.csv`)

One row per country × HCID, copied from UKHSA's *HCID: country specific risk* page, plus rows for sub-national areas from the UKHSA HCID guidance pages (Junin – Pampas; Andes – four Argentine regions and southern Chile; Machupo – Beni; Chapare – Cochabamba/La Paz; Nipah – Bangladesh districts, West Bengal, Kerala, Mindanao; SFTS – central & eastern China; Marburg – Python Cave; Ebola – 2026 DRC outbreak provinces).

| column | meaning |
|---|---|
| country | ISO3 code |
| area | optional id of a shape in `areas.geojson` |
| hcid | pathogen id (`lassa`, `cchf`, `ebola`, `marburg`, `mers`, `avian_flu`, `nipah`, `plague`, `sfts`, `junin`, `machupo`, `chapare`, `lujo`, `andes`, `sars`) |
| category, category_text | UKHSA letter (a) community/zoonotic, (b) limited local spread after import, (c) imported only, (d) serology only, (e) unknown |
| last_reported | as UKHSA gives it |
| show | `yes` = listed for travellers to that country. Defaults: a, d, e yes; b only if the main year is 2025/26; c and SARS no |
| notes, source, checked | |

For HCIDs the countries come **only** from this file: the `where` column of their rules in `exposure_map.csv` is ignored. The report lists, for each stop, every HCID shown for that country with its UKHSA category and year, whether the pin is inside a named area, whether the stay ended within the 14/21/42-day window, the reservoir/vector (from `pathogens.csv` → `reservoir_vector`, `season`), the linked exposures that were ticked and the ones still to ask about. It does not estimate risk.

To update: when UKHSA changes the page, edit or add rows here (and bump `version.txt`).

### Current outbreaks (`alerts.csv`)

| column | meaning |
|---|---|
| where | countries / regions / tags, as above |
| pathogen | optional pathogen id. If set, the alert is shown in red and the pathogen is added to "any stay in this country" (so it reaches the HCID check). Leave blank for an information-only note (blue). |
| title, detail | shown on the stop card and in the report |
| date_checked | when you last verified it |
| review_by | after this date the alert is flagged **STALE – re-check** |
| source_url | link to the source |

### Suggested monthly routine (15 minutes)

1. NaTHNaC **Outbreak surveillance** – <https://travelhealthpro.org.uk/outbreaks> – and **Latest news**.
2. UKHSA **Outbreaks under monitoring** (weekly) – <https://www.gov.uk/government/publications/outbreaks-under-monitoring-in-2026> (change the year each January).
3. UKHSA **HCID country-specific risk** – <https://www.gov.uk/guidance/high-consequence-infectious-disease-country-specific-risk> – check the `lassa`, `cchf`, `mers`, `filovirus_hist` tags.
4. Malaria: NaTHNaC country pages and the CDC Yellow Book malaria-by-country tables; WHO list of countries certified malaria-free (Cabo Verde and Egypt 2024; Georgia, Suriname and Timor-Leste 2025 are already removed). Adjust `malaria_high` / `malaria_risk` tags.
5. Update `alerts.csv`, bump `version.txt`, commit.

## 5. Map data

* Base maps (no API key needed; switch with the layer button, top right of the map): OpenStreetMap standard tiles (default; follow the OSM tile usage policy – fine for light clinical use), Esri light grey with English labels, OpenTopoMap terrain (useful for altitude, e.g. malaria-free highlands), Esri satellite. Edit the `bases` list in `js/app.js` to change them.
* Country boundaries: Natural Earth 1:50m via the `world-atlas` package, loaded from jsDelivr. To remove that dependency, download <https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json> and save it as `data/countries-50m.json`; the site uses the local copy first. (Until then the browser console shows one harmless 404 for that file.)
* French Guiana, Martinique, Guadeloupe, Réunion and Mayotte are part of France's polygon in Natural Earth; `js/app.js` (`OVERSEAS`) splits them out by bounding box.
* If the map cannot load (offline, blocked network), use **+ Add without map**: everything else still works.

## 6. Where the content came from, and what to check

The seed data was drafted from:

* Thwaites GE, Day NPJ. *Approach to fever in the returning traveler.* NEJM 2017;376:548-60 – Tables 1 (life-threatening infections), 2 (history/exposures) and 3 (transmissible infections). Source tag `NEJM2017`.
* Thakker C et al. *UK guidelines for the investigation and management of eosinophilia in returning travellers and migrants.* J Infect 2025;90:106328 – Table 2 (geography of helminths) and section incubation periods. Source tag `BIA2025`.
* *Fever in Returning Travellers – Infection Quick Reference Guide*, v5 July 2025 – risk exposures, HCID windows (VHF 21 d, MERS/avian influenza 14 d), first-line tests, Imported Fever Service number. Source tag `QRG2025`.
* NaTHNaC, UKHSA, ECDC and CDC pages for country lists and current outbreaks (checked 22 Nov 2026).

Rows marked `Expert` in the `source` column come from general infectious-disease knowledge, not from the three documents. They, and all country tag lists, should be reviewed by you before the tool is relied on clinically. Country tags are coarse: most risks are sub-national and seasonal.
