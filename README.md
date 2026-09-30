# Note Site Builder

Turn an Obsidian note, or a whole folder of notes, into a clean website and
matching PDFs: a handout, a course page, a lab manual, a report. Write in
Obsidian as usual; the plugin does the typesetting.

- **Numbered sections and a contents rail** that follows you as you scroll.
- **Numbered figures with captions**, straight from your image embeds.
- **Maths** with KaTeX, `$inline$` and `$$display$$`.
- **A print-ready PDF**, A4 or Letter: each section starts a new page, with a
  running head and page numbers.
- **Several pages from a folder**, with a bar linking them and working
  `[[links]]` between pages.
- **Live preview** in your browser that reloads every time you save.
- **Publish with git**, one click: commit and push the note and its site, for
  example to GitHub Pages.

## Set up a website in one step

Right-click a folder and choose **Set up website…** (or run *Set up a new
website…*). One dialog asks:

- **One page or several.** One page makes a single note into a page. Several
  pages makes every note in the folder a page.
- **Which note is the home page**: an existing one or a new one it creates.
- **Title, the line above it and a subtitle** for the masthead.
- **Where the built site goes** (default `site/` inside the folder).
- **Whether to put it online with GitHub Pages.** If so, it creates a git
  repository if the folder isn't in one, connects GitHub, adds the Pages
  workflow and, if you like, publishes straight away. With the
  [GitHub CLI](https://cli.github.com) signed in, it can create the GitHub
  repository and switch Pages on for you. Without it, you paste the address of
  an empty repository and switch Pages on once in its settings.

Running it again on the same folder updates the settings instead of starting over.

## Use

Open a note, then click the globe in the left ribbon, or run a command from
the command palette:

| Command | What it does |
| --- | --- |
| Set up a new website… | The setup dialog above |
| Build website from current note | Writes `index.html` (and the other pages) and a `figures/` folder |
| Build website and PDF from current note | The same, plus a PDF of the page |
| Start or stop live preview | Serves the page at `http://localhost:8321` and rebuilds on save |
| Open built website / Open built PDF | Opens them in your browser or PDF viewer |
| Publish with git | Lets you pick which folders go along, shows what changed, then commits and pushes |
| Open published website | Opens `https://<you>.github.io/<repo>/` |

You can also right-click a note in the file explorer and choose **Build website**.

By default a note's site goes into a folder next to it, named after the note
(`My Handout.md` → `my-handout-site/`). Change the pattern in settings, or give
one note its own folder with a `site-folder:` property.

## Writing for the page

The note's top-level headings become the numbered sections. The contents rail
lists them, along with the headings one level below. A note whose headings
start at `##` works too. Anything before the first heading opens the page
without a number.

**Figures.** An image embed on its own line becomes a numbered figure. The
caption is the next line if that line is entirely *italic* or **bold**:

```markdown
![[confocal.png|400]]
*Maximum projection of a 5 dpf larva. Scale bar 50 µm.*
```

`|400` sets the display width, as in Obsidian. Other text after the pipe is
used as the caption. A typed "Figure 3." prefix is dropped, because numbering
is automatic.

**The masthead** comes from optional properties:

```yaml
---
title: The cerebellum in *inpp5e* mutants
eyebrow: BIO321 · Practical course 2026
subtitle: A whole-mount immunofluorescence project in larval zebrafish.
notice: "**Draft.** Some sections are still being written."
---
```

Without a `title:`, the page is named after the note.

**Laser lines.** `/laser{488}` shows a dot in the colour of the channel that
line excites, followed by "488 nm", in tables or running text. 405, 488, 561
and 647 are blue, green, orange and far red; other wavelengths get a blend of
their neighbours. The chips appear in Obsidian's reading view and live preview
as well as on the page. Type `/laser` for a list of common lines.

**Several pages.** A folder is a multi-page site when one of its notes has
`site-home: true` (the setup dialog adds it). That note becomes `index.html`;
every other note in the folder and its subfolders becomes a page named after
it, listed in the bar at the top. `site-order: 2` sets a note's place in the
bar, and `site-hide: true` leaves a note out. `[[Other page]]` and
`[[Other page#Heading]]` link across pages; links to notes that aren't on the
site become plain text. Any build or preview command run from any page builds
the whole site.

**Keeping things off the page** without deleting them from the note:

- `## Experiment 3 //hidden`: hides the heading and everything under it, down
  to the next heading of the same or higher level.
- `1) Why use projections? //answer Smaller files, faster analysis`: hides the
  rest of the line after `//answer`, so questions go out without their answers.
  A line that starts with `//answer` is dropped entirely.
- `%% comments %%` are dropped, as in Obsidian's reading view.

**Also supported:** tables (wide ones scroll), callouts (`> [!note]`, including
nested ones), `==highlights==`, task lists and code
blocks. `[[#Heading]]` links jump within the page. Links to other notes become
plain text, since only this note is published. A heading with nothing under it
gets a "to be written" box; you can turn that off in settings.

## Putting it online with GitHub Pages

1. Keep the note in a git repository with a GitHub remote.
2. On GitHub, open *Settings → Pages* and set *Source* to **GitHub Actions**.
3. Add `.github/workflows/pages.yml`, with `path:` set to your site folder:

   ```yaml
   name: Pages
   on: { push: { branches: [main] } }
   permissions: { contents: read, pages: write, id-token: write }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment: { name: github-pages }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/upload-pages-artifact@v3
           with: { path: my-handout-site }
         - uses: actions/deploy-pages@v4
   ```

4. From then on, **Publish with git** is all it takes. It builds the page,
   commits and pushes.

**Choosing what gets published.** The note and its site are always included.
The Publish dialog also lists the note's folder and each folder above it, up to
the top of the repository, and **Add another folder…** takes any other folder
in the repository. Tick the ones to include; the list of changed files updates
as you go, so you can see exactly what will be pushed. Each note remembers its
selection. Settings → *Publish by default* sets the starting point for notes
without one: only the note and its site, its whole folder, or the whole
repository.

## Privacy and what the plugin touches

- It only writes inside the output folder you configure, in your vault.
- The live preview server listens on `127.0.0.1` only.
- The built page loads KaTeX from the jsDelivr CDN for maths. Nothing else is
  fetched, and the plugin itself makes no network requests.
- It runs `git` only when you use Publish, or to stamp the page with the
  commit it was built from, and only when the note is in a git repository.
- PDFs are printed by Obsidian's built-in Chromium. If that isn't available,
  an installed Chrome or Edge is used.

Desktop only.

## Development

```sh
npm install
npm run dev      # rebuilds main.js on change
npm run build    # type-check and production build
```

Release: `npm version patch && git push --follow-tags`. The workflow attaches
`main.js`, `manifest.json` and `styles.css` to a GitHub release.

## License

MIT
