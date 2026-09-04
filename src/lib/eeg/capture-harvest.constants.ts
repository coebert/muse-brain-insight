/**
 * Client-safe constants for the continuous-capture harvest. The harvest itself
 * runs server-side; the UI only needs to describe its rules.
 */

/** A capture must be quiet this long before it is treated as finished. */
export const HARVEST_QUIET_HOURS = 6;
/** Below this many epochs a recording is too short to be worth learning from. */
export const HARVEST_MIN_EPOCHS = 120;
