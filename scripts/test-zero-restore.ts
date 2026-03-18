import { MemWal } from "../packages/sdk/src/memwal.js";

async function main() {
    const m = MemWal.create({
        key: '4b382d411833a58ed4ab2171472c8d17605f9d5f3530fdc57c44ce3f12d7e4db',
        serverUrl: 'http://localhost:8000',
    });

    console.log('=== Zero-State Restore Test ===');
    console.log('DB is empty for namespace "zero-test"\n');

    console.log('Step 1: Restore from chain...');
    const r = await m.restore('zero-test');
    console.log('Restore result:', JSON.stringify(r, null, 2));

    if (r.restored > 0) {
        console.log('\n✅ ZERO-STATE RESTORE WORKED!');
        console.log('\nStep 2: Verify with recall...');
        const rc = await m.recall("smart contract", 5, 'zero-test');
        console.log('Recall:', JSON.stringify(rc, null, 2));
    } else {
        console.log('\n❌ Restore returned 0');
    }
}

main().catch(console.error);
