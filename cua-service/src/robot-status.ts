/**
 * Compile-time kill switch for the retired PMS browser robot.
 *
 * The implementation is intentionally retained, but changing deployment
 * environment variables must never be enough to start it again.
 */
export const PMS_ROBOT_ENABLED: boolean = false;
