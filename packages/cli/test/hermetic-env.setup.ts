// Shared Node-suite isolation runs before any product module captures its home.
import "../../../test/hermetic-env.setup.js";
import { installHttpRequestGuard } from "./fetch-guard.js";

// The CLI's long-request path goes over node:http, so the CLI suite guards it as the shared setup guards fetch.
installHttpRequestGuard();
