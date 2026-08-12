import { installTaskWorker } from "@odinn/kernel/task-worker-host";
import { createRuntimeRegistry } from "./index.ts";

installTaskWorker(createRuntimeRegistry);
