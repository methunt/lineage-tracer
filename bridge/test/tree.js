/**
 * The model folder tree, on a synthetic project.
 *
 * `samples/` is flat and real projects nest several folders deep, so neither one
 * exercises the interesting cases: a folder holding both files and subfolders,
 * a single-child chain worth collapsing, and a name reused at two depths. Built
 * by hand here for the same reason test/merge.js exists.
 *
 * Run directly:  node test/tree.js
 */
const results = [];
const check = (name, pass, detail = '') => results.push([name, pass, detail]);

const model = (name, layer) => ({
    id: `dbt:model.demo.${name}`,
    kind: 'model', name, layer, origin: 'dbt', columns: [],
    meta: { resourceType: 'model' }, definition: {},
});

// staging/crm/base is three deep; analytics holds files AND a subfolder;
// warehouse/only/deep is a single-child chain with one model at the bottom.
const NODES = [
    model('base_crm_customer', 'staging/crm/base'),
    model('stg_crm_orders', 'staging/crm'),
    model('stg_erp', 'staging/erp'),
    model('dim_customer', 'analytics'),
    model('map_product', 'analytics/mapping'),
    model('deep_one', 'warehouse/only/deep'),
    model('root_model', 'models'),
];

async function run() {
    const { resourceTree } = await import('../ui/src/tree.js');
    const nodes = Object.fromEntries(NODES.map(n => [n.id, n]));
    const layerOrder = [...new Set(NODES.map(n => n.layer))].sort();
    const tree = resourceTree(nodes, layerOrder, {}, {});
    const models = tree.find(g => g.resource === 'model');
    const byLabel = list => Object.fromEntries((list || []).map(c => [c.label, c]));

    const top = byLabel(models.children);
    check('top-level folders are listed',
        ['staging', 'analytics', 'models'].every(l => top[l]),
        Object.keys(top).join(', '));

    // The count a reader wants is how much is in there, not how many files sit
    // loose in this exact folder.
    check('a folder counts its whole subtree',
        top.staging?.count === 3, `staging = ${top.staging?.count}, expected 3`);
    check('a folder holding files and subfolders keeps both',
        top.analytics?.count === 2 && top.analytics?.nodes.length === 1
        && top.analytics?.children.length === 1,
        `${top.analytics?.nodes.length} file(s), ${top.analytics?.children.length} subfolder(s)`);

    const staging = byLabel(top.staging?.children);
    check('nesting goes three deep',
        Boolean(byLabel(staging.crm?.children).base),
        Object.keys(byLabel(staging.crm?.children)).join(', '));

    // A chain of folders with one thing at the bottom is one row, not three.
    check('a single-child chain collapses to one row',
        Boolean(top['warehouse/only/deep']),
        Object.keys(top).join(', '));
    check('collapsing does not lose the models underneath',
        top['warehouse/only/deep']?.nodes.length === 1);

    /*
     * The eye acts on the subtree, so every folder must know every layer at or
     * below it. Without this, hiding `staging` leaves `staging/crm` on canvas —
     * the same shape as the sources/models name collision, where a control
     * appeared to do nothing.
     */
    check('a folder knows every layer beneath it',
        ['staging/crm', 'staging/crm/base', 'staging/erp']
            .every(l => top.staging?.descendants.includes(l)),
        (top.staging?.descendants || []).join(', '));
    check('a folder with no models of its own claims none',
        !top.staging?.descendants.includes('staging'),
        'staging holds only subfolders, so it is not itself a layer');

    let failures = 0;
    for (const [name, pass, detail] of results) {
        if (!pass) failures++;
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    }
    console.log(failures === 0
        ? `\nAll ${results.length} tree checks passed.`
        : `\n${failures} tree check(s) failed.`);
    return failures;
}

module.exports = { run };

if (require.main === module) {
    run().then(failures => process.exit(failures === 0 ? 0 : 1));
}
