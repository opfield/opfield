// The console palette (Opfield: graphite and paper, one amber accent) for HTML that Opfield renders
// outside the frontend: static nginx pages and emails. The frontend's own tokens live in
// packages/frontend/src/index.css; these values match them. Keep every colour of server-rendered
// HTML here.

/** Dark theme: graphite. */
export const GRAPHITE = {
  page: '#141414',
  recess: '#171717',
  surface: '#1a1a19',
  raised: '#232322',
  hair: '#2b2b29',
  hairStrong: '#3d3d3a',
  ink: '#f3f2ef',
  soft: '#c9c8c3',
  stone: '#8f8e89',
  amber: '#c8a35f',
  red: '#d98b7c',
} as const;

/** Light theme: paper. */
export const PAPER = {
  page: '#f3f2ef',
  surface: '#fbfaf8',
  ink: '#141414',
  stone: '#64635f',
  hair: '#dddbd5',
  red: '#a2443a',
} as const;

/**
 * CSS custom properties for a static page that follows the visitor's light or dark preference:
 * --page, --ink, --stone and --red.
 */
export const STATIC_PAGE_COLOR_VARIABLES = `:root{--page:${PAPER.page};--ink:${PAPER.ink};--stone:${PAPER.stone};--red:${PAPER.red}}@media(prefers-color-scheme:dark){:root{--page:${GRAPHITE.page};--ink:${GRAPHITE.ink};--stone:${GRAPHITE.stone};--red:${GRAPHITE.red}}}`;
