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
     * Returns an HTML Representation of the component, should have the following structure
     * inside main#container:
     *    #top-observer+
     *    div#virtual-list+
     *    #bottom-observer
     * @returns {string}
     */
    toHTML() {
        return `<div id="top-observer">Top Observer</div>
        <div id="virtual-list"></div>
        <div id="bottom-observer">Bottom Observer</div>`.trim();
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

