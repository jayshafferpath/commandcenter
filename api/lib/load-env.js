// Imported first by server.js for its side effect. A loadEnv() call in
// server.js's body runs only after every import has been evaluated, so
// module-scope reads like PEARL_NAME in pearl-session.js would miss .env.
import { loadEnv } from "./env.js";

loadEnv();
