/** The build id `vite build` bakes in (web/vite.config.ts); "dev" under `vite serve`, undefined in tests. */
declare const __ORCA_BUILD__: string | undefined;
/** True in a branch preview's dev server (ORCA_PREVIEW_UI=1 in the preview command): the page says which bridge answers its /api. */
declare const __ORCA_PREVIEW__: boolean | undefined;
