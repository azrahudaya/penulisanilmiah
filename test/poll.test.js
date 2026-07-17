import assert from 'node:assert/strict';
import { findPollOptionName } from '../src/poll.js';

assert.equal(findPollOptionName({ name: 'Simpan', localId: 1 }), 'simpan');
assert.equal(findPollOptionName({ localId: 2 }, [{ localId: 2, name: 'Setuju' }]), 'setuju');
assert.equal(findPollOptionName({ localId: 3 }, []), '');
console.log('poll option checks passed');
