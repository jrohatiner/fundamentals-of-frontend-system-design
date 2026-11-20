import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { intersectionObserver } from './observer.js';

describe('intersectionObserver configuration merging and target observation', () => {
    let createdObservers;

    beforeEach(() => {
        createdObservers = [];
        globalThis.Element = undefined;
        globalThis.IntersectionObserver = class MockIntersectionObserver {
            constructor(callback, options) {
                this.callback = callback;
                this.options = options;
                this.observed = [];
                createdObservers.push(this);
            }

            observe(target) {
                this.observed.push(target);
            }

            disconnect() {}
        };
    });

    it('preserves default threshold (0.25) when config is omitted, undefined, null, or empty', () => {
        const cb = () => {};
        const target = { nodeType: 1 };

        intersectionObserver([target], cb);
        intersectionObserver([target], cb, undefined);
        intersectionObserver([target], cb, null);
        intersectionObserver([target], cb, {});

        assert.equal(createdObservers.length, 4);
        for (const obs of createdObservers) {
            assert.deepEqual(obs.options, { threshold: 0.25 });
            assert.deepEqual(obs.observed, [target]);
        }
    });

    it('overrides threshold and merges additional options without mutating defaults or caller config', () => {
        const cb = () => {};
        const customConfig = { threshold: 0.75, rootMargin: '16px 0px' };

        intersectionObserver([], cb, customConfig);
        assert.deepEqual(createdObservers[0].options, {
            threshold: 0.75,
            rootMargin: '16px 0px',
        });
        assert.notEqual(createdObservers[0].options, customConfig);

        // Mutating returned options must not leak into subsequent default observer calls
        createdObservers[0].options.threshold = 0.99;
        intersectionObserver([], cb);
        assert.deepEqual(createdObservers[1].options, { threshold: 0.25 });
    });

    it('retains default threshold when custom config specifies only non-threshold properties', () => {
        const cb = () => {};
        intersectionObserver([], cb, { rootMargin: '32px' });

        assert.deepEqual(createdObservers[0].options, {
            threshold: 0.25,
            rootMargin: '32px',
        });
    });
});
