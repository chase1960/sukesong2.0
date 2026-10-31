// Reuse the baseline runner: serial, isolated, bounded, including .test.mjs.
import {main} from '../../scripts/run-baseline-tests.mjs';
main('server').catch(error=>{console.error(error.message);process.exitCode=1;});
