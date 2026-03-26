// Singleton Ddv4Client instance shared across the frontend app.
// Import `ddv4` from here instead of creating multiple instances.

import { Ddv4Client } from "@ddv4/sw-client";

export const ddv4 = new Ddv4Client({ swPath: "/ddv4-sw.js" });
