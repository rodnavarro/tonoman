import { runCli } from '../../../talent-sdk';
import { manifest } from './manifest';
import { run } from './run';

// The CLI entrypoint the runtime spawns. runCli owns the process boundary; run() is orchestration
// over the capability context.
void runCli(manifest, run);

export { manifest, run };
