/** API server port (the local bridge). Kept in a leaf module — deliberately free of any
 *  `orca.config` import — so tooling that only needs the port (the Vite dev proxy) doesn't pull
 *  orca.config into its module graph. When it did, editing orca.config made Vite treat it as a
 *  config dependency and "restart server", and that restart intermittently hung the dev server
 *  (process alive, no longer listening on :8788). */
export const API_PORT = Number(process.env.ORCA_API_PORT ?? 8787);
