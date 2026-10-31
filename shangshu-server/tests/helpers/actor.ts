import type { ActorContext } from '../../src/core/actor.ts';
import type { Context } from '../../src/core/types.ts';
export const testActor: ActorContext = { id:'tester',role:'admin',kind:'human',channel:'test' };
export const testContext = (ctx: Context): Context => ({...ctx,actor:testActor});

import { withActor } from '../../src/core/actor.ts';
import { requestConfirmation } from '../../src/core/confirm.ts';
export const proposeForTest: typeof requestConfirmation = (...args) => withActor(testActor, () => requestConfirmation(...args));
