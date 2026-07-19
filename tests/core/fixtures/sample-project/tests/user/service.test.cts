import { deactivateUser } from "../../src/user/service";

export function verifiesDeactivation() {
  return deactivateUser({ id: "fixture-user", active: true }).active === false;
}
