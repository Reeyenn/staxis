/**
 * Shared compile-time status for the retired browser-based PMS robot.
 *
 * Keep this module client-safe: UI surfaces and server routes both import it.
 * The implementation remains in the repository for reference, but no product
 * surface or web-app action may expose or start it while this is false.
 */
export const PMS_ROBOT_ENABLED: boolean = false;
