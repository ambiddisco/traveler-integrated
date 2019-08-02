/* globals d3 */
import GoldenLayoutView from '../common/GoldenLayoutView.js';
import LinkedMixin from '../common/LinkedMixin.js';
import prettyPrintTime from '../../utils/prettyPrintTime.js';

class TreeView extends LinkedMixin(GoldenLayoutView) {
  constructor (argObj) {
    argObj.resources = [
      { type: 'less', url: 'views/TreeView/style.less' },
      { type: 'text', url: 'views/TreeView/template.html' }
    ];
    super(argObj);

    this.colorMode = 'INCLUSIVE';

    (async () => {
      try {
        this.tree = d3.hierarchy(await d3.json(`/datasets/${encodeURIComponent(this.layoutState.label)}/tree`));
      } catch (err) {
        this.tree = err;
      }
      this.render();
    })();
  }
  get isLoading () {
    return super.isLoading || !this.tree;
  }
  get isEmpty () {
    return this.tree !== undefined && this.tree instanceof Error;
  }
  setup () {
    super.setup();

    this.margin = {
      top: 20,
      right: 20,
      bottom: 20,
      left: 20
    };
    this.nodeWidth = 120;
    this.nodeHeight = 20;
    this.nodeSeparation = 1.5; // Factor (not px) for separating nodes vertically
    this.horizontalPadding = 40; // px separation between nodes
    this.mainGlyphRadius = this.nodeHeight / 2;
    this.expanderRadius = this.mainGlyphRadius / 2;

    this.content.html(this.resources[1]);

    // Redraw when a new primitive is selected
    // TODO: auto-expand and scroll if the selected primitive is collapsed?
    this.linkedState.on('primitiveSelected', () => { this.render(); });
  }
  draw () {
    super.draw();

    if (this.isHidden || this.isLoading) {
      return; // eslint-disable-line no-useless-return
    } else if (this.histogram instanceof Error) {
      this.emptyStateDiv.html('<p>Error communicating with the server</p>');
    } else {
      // Compute the new layout
      this.updateLayout();

      // Draw the legend (note: this also sets up this.currentColorTimeScale)
      this.drawLegend();

      const transition = d3.transition()
        .duration(1000);

      // Draw the nodes
      this.drawNodes(transition);

      // Draw the links
      this.drawLinks(transition);

      // Draw any hovered links
      this.drawHoveredLinks();

      // Trash any interaction placeholders now that we've used them
      delete this._expandedParentCoords;
      delete this._collapsedParent;
    }
  }
  updateLayout () {
    // Compute the minimum VERTICAL layout (mbostock's example / the d3 docs are
    // really confusing about this), with fixed node sizes / separation—we'll
    // rotate this later
    const layoutGenerator = d3.tree()
      .nodeSize([this.nodeHeight, this.nodeWidth + this.horizontalPadding])
      .separation(() => this.nodeSeparation);
    layoutGenerator(this.tree);
    const xDomain = d3.extent(this.tree.descendants(), d => d.x);
    const yDomain = d3.extent(this.tree.descendants(), d => d.y);

    // Figure out how much space we have to work with. Here we need to deal with
    // space for each node: we want the x coordinate to correspond to the left
    // coordinate of the node (text will flow right), and the y coordinate to
    // correspond with the center of the node. Also, factor in the
    // scroll bars + margins.
    const viewBounds = this.getAvailableSpace();
    const xRange = [this.margin.left, Math.max(
      // The minimum right-most coordinate (remember the original domain is rotated)
      this.margin.left + yDomain[1] - yDomain[0],
      // How far over it could be if we use the available screen space
      viewBounds.width - this.scrollBarSize - this.nodeWidth - this.margin.right
    )];
    const yRange = [this.margin.top + this.nodeHeight / 2, Math.max(
      // The minimum bottom-most coordinate (remember the original domain is rotated)
      this.margin.top + this.nodeHeight / 2 + xDomain[1] - xDomain[0],
      // How far down it could be if we use the available screen space
      viewBounds.height - this.scrollBarSize - this.nodeHeight / 2 - this.margin.bottom
    )];

    // Update the coordinates
    const yToX = d3.scaleLinear().domain(yDomain).range(xRange);
    const xToY = d3.scaleLinear().domain(xDomain).range(yRange);
    for (const node of this.tree.descendants()) {
      const temp = node.x;
      node.x = yToX(node.y);
      node.y = xToY(temp);
    }

    // Resize our SVG element to the needed size
    this.content.select('svg.tree')
      .attr('width', xRange[1] + this.nodeWidth + this.margin.right)
      .attr('height', yRange[1] + this.nodeHeight / 2 + this.margin.bottom);
  }
  drawLegend () {
    // TODO: get this list based on this.colorMode; for now we just look at
    // inclusive time
    const colorMap = TreeView.COLOR_MAPS.INCLUSIVE;
    const times = this.tree.descendants()
      .map(d => this.linkedState.getPrimitiveDetails(d.data.name).time)
      .filter(d => d !== undefined);
    if (times.length === 0) {
      return; // No time data; don't bother creating the legend
    }

    // Set the color scale for this function (and the others)
    this.currentColorTimeScale = d3.scaleQuantize()
      .domain(d3.extent(times))
      .range(colorMap);
    // Get the domain windows for each color
    const windows = colorMap.map(d => this.currentColorTimeScale.invertExtent(d));
    const ticks = [windows[0][0]].concat(windows.map(d => d[1]));

    // Create a spatial scale + axis based on the color map
    const axisScale = d3.scaleLinear()
      .domain([ticks[0], ticks[ticks.length - 1]])
      .range([0, 300]);
    const axis = d3.axisBottom()
      .scale(axisScale)
      .tickSize(13)
      .tickValues(ticks)
      .tickFormat(d => prettyPrintTime(d));
    // This blows away the previous contents (if any), so we can just deal in
    // .enter() calls from here on
    const g = this.d3el.select('.legend .contents').call(axis);

    // Patch the d3-generated axis
    g.select('.domain').remove();
    g.selectAll('rect').data(colorMap)
      .enter()
      .insert('rect', '.tick')
      .attr('height', 8)
      .attr('x', (d, i) => axisScale(windows[i][0]))
      .attr('width', (d, i) => axisScale(windows[i][1]) - axisScale(windows[i][0]))
      .attr('fill', d => d);
  }
  drawNodes (transition) {
    let nodes = this.content.select('.nodeLayer').selectAll('.node')
      .data(this.tree.descendants(), d => d.data.name);
    const nodesEnter = nodes.enter().append('g').classed('node', true);
    const nodesExit = nodes.exit();
    nodes = nodes.merge(nodesEnter);

    // Start new nodes at their parents' old coordinates (or their native
    // coordinates if this is the first draw)
    nodesEnter.attr('transform', d => {
      if (this._expandedParentCoords) {
        return `translate(${this._expandedParentCoords.x + this.nodeWidth},${this._expandedParentCoords.y})`;
      } else {
        return `translate(${d.x},${d.y})`;
      }
    }).attr('opacity', 0);
    // Move old nodes to clicked node's new coordinates, and then remove them
    nodesExit.transition(transition)
      .attr('transform', d => {
        if (this._collapsedParent) {
          return `translate(${this._collapsedParent.x + this.nodeWidth},${this._collapsedParent.y})`;
        } else {
          return `translate(${d.parent.x + this.nodeWidth}, ${d.parent.y})`;
        }
      })
      .attr('opacity', 0)
      .remove();
    // Move all new + existing nodes to their target coordinates
    nodes.transition(transition)
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .attr('opacity', 1);

    // Main glyph (just circles for now)
    const mainGlyphEnter = nodesEnter.append('g').classed('mainGlyph', true);
    mainGlyphEnter.append('path').classed('area', true);
    mainGlyphEnter.append('path').classed('outline', true);
    mainGlyphEnter.append('text').classed('unknownValue', true)
      .attr('x', this.mainGlyphRadius)
      .attr('text-anchor', 'middle')
      .attr('y', 3)
      .style('opacity', 0)
      .text('?');
    const mainGlyph = nodes.select('.mainGlyph');
    mainGlyph.selectAll('.area')
      .transition(transition)
      .attr('d', TreeView.GLYPHS.CIRCLE(this.mainGlyphRadius))
      .attr('fill', d => {
        const time = this.linkedState.getPrimitiveDetails(d.data.name).time;
        if (time === undefined) {
          return 'transparent';
        } else {
          return this.currentColorTimeScale(time);
        }
      });
    mainGlyph.selectAll('.outline')
      .transition(transition)
      .attr('d', TreeView.GLYPHS.CIRCLE(1.5 * this.mainGlyphRadius))
      .attr('transform', `translate(${-0.5 * this.mainGlyphRadius})`);
    mainGlyph.selectAll('.unknownValue')
      .transition(transition)
      .style('opacity', d => {
        return this.linkedState.getPrimitiveDetails(d.data.name).time === undefined ? 1 : 0;
      });

    // Node label
    nodesEnter.append('text')
      .attr('x', 2 * this.mainGlyphRadius)
      .attr('y', this.mainGlyphRadius)
      .text(d => this.linkedState.getPrimitiveDetails(d.data.name).name);

    // Collapse / expand glyph
    const expanderGlyphEnter = nodesEnter.append('g').classed('expander', true)
      .attr('transform', `translate(${2 * this.mainGlyphRadius},${-this.mainGlyphRadius})`);
    expanderGlyphEnter.append('path').classed('area', true);
    expanderGlyphEnter.append('path').classed('outline', true);
    nodes.select('.expander').selectAll('.area, .outline')
      .on('click', d => {
        // Hide / show the children
        if (d._children) {
          d.children = d._children;
          delete d._children;
          // New child animations need to start growing from this old parent
          // coordinate
          this._expandedParentCoords = { x: d.x, y: d.y };
        } else {
          d._children = d.children;
          delete d.children;
          // Old child animations need to end at this parent, but at its new
          // coordinates (so just keep track of which parent; its coordinates
          // will get updated later by updateLayout)
          this._collapsedParent = d;
        }
        this.render();
        d3.event.stopPropagation();
      }).transition(transition)
      .attr('d', d => {
        if (d._children) {
          // There are hidden children
          return TreeView.GLYPHS.COLLAPSED_TRIANGLE(this.expanderRadius);
        } else if (!d.children || d.children.length === 0) {
          // No children; this is a leaf
          return null;
        } else {
          // All children are showing
          return TreeView.GLYPHS.EXPANDED_TRIANGLE(this.expanderRadius);
        }
      });

    // Main interactions
    const self = this;
    nodes.classed('selected', d => this.linkedState.selectedPrimitive === d.data.name)
      .on('click', d => {
        this.linkedState.selectPrimitive(d.data.name);
      }).on('mouseenter', function (d) {
        const primitive = self.linkedState.getPrimitiveDetails(d.data.name);
        if (!primitive) {
          console.warn(`Can't find primitive of name: ${d.data.name}`);
        } else {
          window.controller.tooltip.show({
            content: `<pre>${d.data.name}: ${JSON.stringify(primitive, null, 2)}</pre>`,
            targetBounds: this.getBoundingClientRect(),
            hideAfterMs: null
          });
        }
      }).on('mouseleave', () => {
        window.controller.tooltip.hide();
      });
  }
  drawLinks (transition) {
    let links = this.content.select('.linkLayer').selectAll('.link')
      .data(this.tree.links(), d => d.source.data.name + d.target.data.name);
    const linksEnter = links.enter().append('path').classed('link', true);
    const linksExit = links.exit();
    links = links.merge(linksEnter);

    // Helper function for computing custom paths:
    const computePath = (source, target) => {
      const curveX = target.x - this.horizontalPadding / 2;
      return `\
M${source.x + 2 * this.mainGlyphRadius},${source.y}\
L${source.x + this.nodeWidth},${source.y}\
C${curveX},${source.y},${curveX},${target.y},${target.x},${target.y}`;
    };
    linksEnter
      .attr('opacity', 0)
      .attr('d', link => {
        // Start new links at the end of the old clicked target if it exists, or
        // the end of the parent if this is the first draw
        if (this._expandedParentCoords) {
          return computePath(this._expandedParentCoords, this._expandedParentCoords);
        } else {
          return computePath(link.source, {
            x: link.source.x + this.nodeWidth,
            y: link.source.y
          });
        }
      });
    linksExit.transition(transition)
      .attr('opacity', 0)
      .attr('d', link => {
        // End old links at the end of the parent's new coordinates
        return computePath(this._collapsedParent || link.source, this._collapsedParent || link.source);
      })
      .remove();
    links.transition(transition)
      .attr('opacity', 1)
      .attr('d', link => {
        // Animate to the correct locations
        return computePath(link.source, link.target);
      });
  }
  drawHoveredLinks () {
    // TODO
  }
}
TreeView.COLOR_MAPS = {
  INCLUSIVE: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'], // purple
  EXCLUSIVE: ['#edf8fb', '#b2e2e2', '#66c2a4', '#2ca25f', '#006d2c'], // green
  DIFFERENCE: ['#ca0020', '#f4a582', '#f7f7f7', '#92c5de', '#0571b0'] // diverging red blue
};
TreeView.GLYPHS = {
  CIRCLE: r => `\
M${r},${-r}\
A${r},${r},0,0,0,${r},${r}\
A${r},${r},0,0,0,${r},${-r}\
Z`,
  COLLAPSED_TRIANGLE: r => `\
M0,0\
L${2 * r},${r}\
L0,${2 * r}\
L${r},${r}\
Z`,
  EXPANDED_TRIANGLE: r => `\
M${2 * r},0\
L0,${r}\
L${2 * r},${2 * r}\
L${r},${r}\
Z`
};
export default TreeView;
