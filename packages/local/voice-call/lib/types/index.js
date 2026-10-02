/**
 * Host half of the Voice Call bundle.
 *
 * The capability is entirely browser-side: the composer's microphone control,
 * the live caption strip, and the speech synthesis/recognition runtime. Nothing
 * here touches the session log, so the Host half stays inert and only seats the
 * Loader row that carries the package's `dsh.client` browser half into the page.
 */

/** Seat the Voice Call row; the Client module owns every visible behavior. */
export function apply() {}
