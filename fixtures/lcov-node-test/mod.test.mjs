import { test } from 'node:test';
import { called } from './mod.mjs';
test('x', () => { called(); });
