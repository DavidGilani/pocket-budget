// Database schema and operations via Dexie.js

const db = new Dexie('PocketLedger');

db.version(1).stores({
  transactions:      '++id, date, categoryId, type, distributionId, syncStatus',
  categories:        '++id, sortOrder, isArchived, isIncome',
  recurringIncome:   '++id, isActive, startDate',
  recurringExpenses: '++id, isActive, startDate, isShared',
  savingsTargets:    '++id, startDate',
  distributions:     '++id, isFinished, startDate',
  accounts:          '++id, sortOrder, isActive',
  accountSnapshots:  '++id, accountId, date',
  friendHoldings:    '++id, isActive',
  friendTransactions:'++id, holdingId, date',
  syncQueue:         '++id, status, tableName',
  settings:          'key',
});

const SEED_CATEGORIES = [
  { id:1,  name:'Transportation',          icon:'🚗', colour:'#607D8B', isIncome:false, sortOrder:1,  isArchived:false, legacyId:24 },
  { id:2,  name:'Food / house shop',       icon:'🛒', colour:'#8D6E63', isIncome:false, sortOrder:2,  isArchived:false, legacyId:1  },
  { id:3,  name:'Food out (unplanned)',    icon:'🧁', colour:'#FF9800', isIncome:false, sortOrder:3,  isArchived:false, legacyId:14 },
  { id:4,  name:'Restaurant',              icon:'🍽️', colour:'#F44336', isIncome:false, sortOrder:4,  isArchived:false, legacyId:34 },
  { id:5,  name:'Entertainment',           icon:'🎬', colour:'#9C27B0', isIncome:false, sortOrder:5,  isArchived:false, legacyId:23 },
  { id:6,  name:'Takeaway',               icon:'🥡', colour:'#FF5722', isIncome:false, sortOrder:6,  isArchived:false, legacyId:10 },
  { id:7,  name:'Charity / gifts',         icon:'🎁', colour:'#E91E63', isIncome:false, sortOrder:7,  isArchived:false, legacyId:12 },
  { id:8,  name:'Health and beauty',       icon:'💊', colour:'#00ACC1', isIncome:false, sortOrder:8,  isArchived:false, legacyId:33 },
  { id:9,  name:'Household',               icon:'🏠', colour:'#43A047', isIncome:false, sortOrder:9,  isArchived:false, legacyId:16 },
  { id:10, name:'Clothing',               icon:'👕', colour:'#1E88E5', isIncome:false, sortOrder:10, isArchived:false, legacyId:15 },
  { id:11, name:'Leisure',                icon:'🏖️', colour:'#00BCD4', isIncome:false, sortOrder:11, isArchived:false, legacyId:32 },
  { id:12, name:'Education',              icon:'📚', colour:'#3F51B5', isIncome:false, sortOrder:12, isArchived:false, legacyId:25 },
  { id:13, name:'Extra income',           icon:'💰', colour:'#43A047', isIncome:true,  sortOrder:13, isArchived:false, legacyId:27 },
  { id:14, name:'Expenses', icon:'💼', colour:'#009688', isIncome:true,  sortOrder:14, isArchived:false, legacyId:6  },
  { id:15, name:'Socializing',   icon:'🍻', colour:'#FF9800', isIncome:false, sortOrder:99, isArchived:true, legacyId:3  },
  { id:16, name:'Health',        icon:'🏥', colour:'#F44336', isIncome:false, sortOrder:99, isArchived:true, legacyId:22 },
  { id:17, name:'Bills',         icon:'📋', colour:'#607D8B', isIncome:false, sortOrder:99, isArchived:true, legacyId:20 },
  { id:18, name:'Personal Care', icon:'💆', colour:'#E91E63', isIncome:false, sortOrder:99, isArchived:true, legacyId:7  },
  { id:19, name:'Drinks',        icon:'☕', colour:'#795548', isIncome:false, sortOrder:99, isArchived:true, legacyId:26 },
  { id:20, name:'Sale',          icon:'🏷️', colour:'#9E9E9E', isIncome:true,  sortOrder:99, isArchived:true, legacyId:21 },
  { id:21, name:'Investment',    icon:'📈', colour:'#43A047', isIncome:true,  sortOrder:99, isArchived:true, legacyId:9  },
  { id:22, name:'General',       icon:'📦', colour:'#9E9E9E', isIncome:false, sortOrder:99, isArchived:true, legacyId:28 },
  { id:23, name:'Fuel',          icon:'⛽', colour:'#FF9800', isIncome:false, sortOrder:99, isArchived:true, legacyId:29 },
  { id:24, name:'Hobby',         icon:'🎨', colour:'#9C27B0', isIncome:false, sortOrder:99, isArchived:true, legacyId:13 },
  { id:25, name:'Groceries',     icon:'🥦', colour:'#8D6E63', isIncome:false, sortOrder:99, isArchived:true, legacyId:2  },
  { id:26, name:'Coffee',        icon:'☕', colour:'#795548', isIncome:false, sortOrder:99, isArchived:true, legacyId:11 },
  { id:27, name:'Bonus',         icon:'⭐', colour:'#FFC107', isIncome:true,  sortOrder:99, isArchived:true, legacyId:30 },
  { id:28, name:'Misc',          icon:'📦', colour:'#9E9E9E', isIncome:false, sortOrder:13, isArchived:false },
];

const SEED_ACCOUNTS = [
  { id:1,  name:'Current account',          type:'bank',       isAsset:true,  sortOrder:1,  isActive:true  },
  { id:2,  name:'Credit cards',             type:'credit',     isAsset:false, sortOrder:2,  isActive:true  },
  { id:3,  name:'Vida ISA',                 type:'savings',    isAsset:true,  sortOrder:3,  isActive:true  },
  { id:4,  name:'Trading 212 cash ISA',     type:'savings',    isAsset:true,  sortOrder:4,  isActive:true  },
  { id:5,  name:'Flex saver',               type:'savings',    isAsset:true,  sortOrder:5,  isActive:true  },
  { id:6,  name:'Tembo',                    type:'savings',    isAsset:true,  sortOrder:6,  isActive:true  },
  { id:7,  name:'SJP stocks ISA',           type:'investment', isAsset:true,  sortOrder:7,  isActive:true  },
  { id:8,  name:'Trading 212 stocks ISA',   type:'investment', isAsset:true,  sortOrder:8,  isActive:true  },
  { id:9,  name:'Student loan',             type:'loan',       isAsset:false, sortOrder:9,  isActive:true  },
  { id:10, name:'APCs',                     type:'pension',    isAsset:true,  sortOrder:10, isActive:true  },
  { id:11, name:'Property',                 type:'property',   isAsset:true,  sortOrder:11, isActive:true  },
  { id:12, name:'Mortgage',                 type:'mortgage',   isAsset:false, sortOrder:12, isActive:true  },
  { id:13, name:'Bank of Gilulu',           type:'holding',    isAsset:true,  sortOrder:13, isActive:true  },
];

async function initDB() {
  const count = await db.categories.count();
  if (count === 0) {
    await db.categories.bulkAdd(SEED_CATEGORIES);
    await db.accounts.bulkAdd(SEED_ACCOUNTS);
    await db.settings.bulkAdd([
      { key: 'cycleStartDay', value: 1 },
      { key: 'currency', value: 'GBP' },
      { key: 'savingsAmount', value: 1500 },
      { key: 'lastSnapshotReminder', value: null },
    ]);
  }
}

async function getSetting(key) {
  const row = await db.settings.get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

async function buildCategoryLegacyMap() {
  const cats = await db.categories.toArray();
  const map = {};
  cats.forEach(c => { if (c.legacyId != null) map[c.legacyId] = c.id; });
  return map;
}

export { db, initDB, getSetting, setSetting, buildCategoryLegacyMap, SEED_CATEGORIES };
