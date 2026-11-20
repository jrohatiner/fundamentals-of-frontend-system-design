/**
 * Part 2 - Register Bottom Observer
 *
 * 1. Create a IntersectionObserver callback #handleIntersectionObserver
 * 2. Extract id of the element from the intersection entry
 * 3. based on the id (bottom or top) - run required callback
 * 3.1 Create empty handleTopObserver method
 * 3.2 Create empty handleBottomObserver method
 * 4. Inside #effect method, register the observer
 */
export class VirtualList {
    /**
     * @param root
     * @param props {{}}
     */
    constructor(root, props) {
        this.props = {...props};
        this.root = root;
    }

    /**
     * Returns an HTML Representation of the component, should have the following structure:
     * #container>
     *    .top-observer+
     *    #virtual-list+
     *    #bottom-observer
     * @returns {string}
     */
    toHTML() {
        return `<main id="container">
        <h1>Virtualisation</h1>
        <div id="top-observer">Top Observer</div>
        <div id="virtual-list"></div>
        <div id="bottom-observer">Bottom Observer</div>
        </main>`.trim();
    }

    /**
     * Registers Events / Observers, this function is run after initial render
     * @returns void
     */
    #effect() {}

    /**
     * Renders the content to the provided root container and runs
     * any additional side effects
     * @returns void
     */
    render() {
        this.root.innerHTML = this.toHTML();
        this.#effect()
    }


}

