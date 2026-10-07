import * as s from './schema/index.ts';
import { DEMO_SEEDERS, PEOPLE, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { pick } from './seed-demo-crm.ts';

DEMO_SEEDERS.push({
  name: 'it',
  async run({ tx, users: u, employees: emp }: SeedCtx) {
    let n = 0;
    for (const p of PEOPLE) {
      n++;
      const [lt] = await tx.insert(s.assets).values({
        tag: `LT-${String(n).padStart(3, '0')}`, kind: 'laptop', brand: pick(['Dell', 'Lenovo', 'Apple']), model: pick(['Latitude 5440', 'ThinkPad T14', 'MacBook Pro 14']),
        serialNumber: `SN${100000 + n * 7919}`, purchaseDate: daysFromNow(-400 - n * 10), purchaseCost: '1100', vendor: 'Tech Store',
        warrantyUntil: daysFromNow(n === 3 ? 20 : 300 + n * 5), status: 'assigned', assignedEmployeeId: emp[p.h], assignedOn: daysFromNow(-300), condition: 'Good',
      }).returning();
      await tx.insert(s.assetAssignments).values({ assetId: lt.id, employeeId: emp[p.h], assignedOn: daysFromNow(-300), conditionOut: 'Good', assignedById: u.danish });
      if (['ali', 'zainab', 'maryam', 'hina'].includes(p.h)) {
        await tx.insert(s.assets).values({ tag: `MN-${String(n).padStart(3, '0')}`, kind: 'monitor', brand: 'Dell', model: 'U2723QE', status: 'assigned', assignedEmployeeId: emp[p.h], assignedOn: daysFromNow(-200), purchaseCost: '520' });
      }
    }
    await tx.insert(s.assets).values([
      { tag: 'LT-100', kind: 'laptop', brand: 'Lenovo', model: 'ThinkPad T14', status: 'in_stock', purchaseCost: '1050' },
      { tag: 'LT-101', kind: 'laptop', brand: 'Dell', model: 'Latitude 5440', status: 'in_repair', condition: 'Battery swelling', purchaseCost: '1100' },
      { tag: 'PH-001', kind: 'phone', brand: 'Samsung', model: 'Galaxy A55 (QA device)', status: 'in_stock', purchaseCost: '400' },
    ]);

    const subs = [
      ['Google Workspace', 'Google', 'saas', 'Business Standard', 'monthly', 12 * 17, 20, 25, 'communication', 'email'],
      ['GitHub Team', 'GitHub', 'saas', 'Team', 'monthly', 4 * 10, 10, 40, 'github', 'github'],
      ['Figma', 'Figma', 'saas', 'Professional', 'yearly', 540, 4, 300, 'design', 'design'],
      ['ClickUp', 'ClickUp', 'saas', 'Business', 'monthly', 12 * 17, 20, 12, 'project_management', 'project_management'],
      ['Slack', 'Slack', 'saas', 'Pro', 'monthly', 8.75 * 17, 20, 8, 'communication', 'communication'],
      ['Elementor Pro (Agency)', 'Elementor', 'license', 'Agency', 'yearly', 399, 1000, 200, 'other', 'other'],
      ['Ahrefs', 'Ahrefs', 'saas', 'Standard', 'monthly', 199, 2, 18, 'other', 'other'],
    ] as const;
    const subIds: Record<string, string> = {};
    for (const [name, vendor, category, plan, cycle, cost, seats, renews] of subs) {
      const [row] = await tx.insert(s.subscriptions).values({
        name, vendor, category, plan, billingCycle: cycle, cost: String(cost), seatsTotal: seats, renewalDate: daysFromNow(renews), ownerId: u.danish,
        vaultReference: `op://Devtics/${name}/admin`,
      }).returning();
      subIds[name] = row.id;
    }
    const seat = async (sub: string, handles: string[]) => {
      for (const h of handles) await tx.insert(s.licenseAssignments).values({ subscriptionId: subIds[sub], employeeId: emp[h], accountIdentifier: `${h}@devtics.example`, assignedOn: daysFromNow(-200) });
      await tx.execute((await import('drizzle-orm')).sql`update subscriptions set seats_used = ${handles.length} where id = ${subIds[sub]}`);
    };
    await seat('Google Workspace', PEOPLE.map((p) => p.h));
    await seat('GitHub Team', ['bilal', 'ali', 'zainab', 'fahad', 'hamza', 'nida']);
    await seat('Figma', ['maryam', 'hina']);
    await seat('Ahrefs', ['kamran']);
    for (const p of PEOPLE) {
      await tx.insert(s.accessGrants).values({ employeeId: emp[p.h], system: 'email', systemName: 'Google Workspace', subscriptionId: subIds['Google Workspace'], accountIdentifier: `${p.h}@devtics.example`, accessLevel: 'member', grantedOn: daysFromNow(-300), grantedById: u.danish });
      await tx.insert(s.accessGrants).values({ employeeId: emp[p.h], system: 'dms', systemName: 'Devtics DMS', accountIdentifier: `${p.h}@devtics.example`, accessLevel: p.roles.join(', '), grantedOn: daysFromNow(-300), grantedById: u.imran });
    }
    for (const h of ['bilal', 'ali', 'zainab', 'fahad']) await tx.insert(s.accessGrants).values({ employeeId: emp[h], system: 'github', systemName: 'GitHub', subscriptionId: subIds['GitHub Team'], accountIdentifier: `${h}-devtics`, accessLevel: h === 'bilal' ? 'owner' : 'member', grantedOn: daysFromNow(-250), grantedById: u.danish });

    await tx.insert(s.infraResources).values([
      { kind: 'domain', name: 'devtics.example', provider: 'Namecheap', expiresOn: daysFromNow(18), autoRenew: false, cost: '14', billingCycle: 'yearly', ownerId: u.danish, vaultReference: 'op://Devtics/Namecheap/admin' },
      { kind: 'ssl_certificate', name: '*.devtics.example', provider: "Let's Encrypt", expiresOn: daysFromNow(9), autoRenew: true, ownerId: u.danish },
      { kind: 'cloud_account', name: 'AWS — Devtics main', provider: 'AWS', identifier: 'Account 1234-5678-9012', region: 'eu-west-1', cost: '640', billingCycle: 'monthly', ownerId: u.bilal, vaultReference: 'op://Devtics/AWS root/credentials' },
      { kind: 'hosting', name: 'Managed WordPress — client sites', provider: 'Kinsta', cost: '115', billingCycle: 'monthly', expiresOn: daysFromNow(120), ownerId: u.danish },
      { kind: 'dns_zone', name: 'devtics.example zone', provider: 'Cloudflare', ownerId: u.danish },
      { kind: 'server', name: 'staging-1', provider: 'Hetzner', identifier: '10.0.0.12', region: 'fsn1', cost: '29', billingCycle: 'monthly', ownerId: u.bilal },
      { kind: 'api', name: 'Stripe (client payments)', provider: 'Stripe', ownerId: u.bilal, vaultReference: 'op://Devtics/Stripe/api-keys' },
    ]);
  },
});
