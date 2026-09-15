import { runCli } from '../../../talent-sdk';
import { manifest } from './manifest';
import { run } from './run';

// The CLI entrypoint. runCli owns the process boundary (env + stdin in, outcome on stdout); run()
// is pure orchestration over the capability context. This file is what the runtime spawns.
void runCli(manifest, run);

export { manifest, run };
