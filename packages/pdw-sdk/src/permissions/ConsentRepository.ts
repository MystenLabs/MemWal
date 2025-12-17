import {
  ConsentRequestRecord,
  ConsentStatus,
} from '../core/types/wallet.js';
import { normalizeSuiAddress } from '@mysten/sui/utils';

export interface ConsentRepository {
  save(request: ConsentRequestRecord): Promise<void>;
  updateStatus(requestId: string, status: ConsentStatus, updatedAt: number): Promise<void>;
  getById(requestId: string): Promise<ConsentRequestRecord | null>;
  listByTarget(targetWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]>;
  listByRequester(requesterWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]>;
  delete(requestId: string): Promise<void>;
}

interface StoredConsentRecord extends ConsentRequestRecord {}

function normalizeRecord(record: ConsentRequestRecord): StoredConsentRecord {
  return {
    ...record,
    requesterWallet: normalizeSuiAddress(record.requesterWallet),
    targetWallet: normalizeSuiAddress(record.targetWallet),
  };
}

/**
 * FileSystemConsentRepository - Node.js only implementation
 * Uses file system for persistence. Not available in browser.
 */
export class FileSystemConsentRepository implements ConsentRepository {
  private filePath: string;
  private initialized = false;

  constructor(options?: { filePath?: string }) {
    this.filePath = options?.filePath ?? '';
  }

  async save(request: ConsentRequestRecord): Promise<void> {
    const records = await this.readAll();
    const normalized = normalizeRecord(request);
    const index = records.findIndex((item) => item.requestId === normalized.requestId);
    if (index >= 0) {
      records[index] = normalized;
    } else {
      records.push(normalized);
    }
    await this.writeAll(records);
  }

  async updateStatus(requestId: string, status: ConsentStatus, updatedAt: number): Promise<void> {
    const records = await this.readAll();
    const index = records.findIndex((item) => item.requestId === requestId);
    if (index === -1) {
      return;
    }

    records[index] = {
      ...records[index],
      status,
      updatedAt,
    };

    await this.writeAll(records);
  }

  async getById(requestId: string): Promise<ConsentRequestRecord | null> {
    const records = await this.readAll();
    const record = records.find((item) => item.requestId === requestId);
    return record ? { ...record } : null;
  }

  async listByTarget(targetWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedTarget = normalizeSuiAddress(targetWallet);
    const records = await this.readAll();
    return records
      .filter((record) => record.targetWallet === normalizedTarget)
      .filter((record) => (status ? record.status === status : true))
      .map((record) => ({ ...record }));
  }

  async listByRequester(requesterWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedRequester = normalizeSuiAddress(requesterWallet);
    const records = await this.readAll();
    return records
      .filter((record) => record.requesterWallet === normalizedRequester)
      .filter((record) => (status ? record.status === status : true))
      .map((record) => ({ ...record }));
  }

  async delete(requestId: string): Promise<void> {
    const records = await this.readAll();
    const filtered = records.filter((record) => record.requestId !== requestId);
    if (filtered.length === records.length) {
      return;
    }
    await this.writeAll(filtered);
  }

  private async readAll(): Promise<StoredConsentRecord[]> {
    await this.ensureInitialized();
    const fs = await import('fs/promises');
    try {
      const buffer = await fs.readFile(this.filePath);
      const parsed = JSON.parse(buffer.toString()) as StoredConsentRecord[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((record) => normalizeRecord(record));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async writeAll(records: StoredConsentRecord[]): Promise<void> {
    await this.ensureInitialized();
    const fs = await import('fs/promises');
    const serialized = JSON.stringify(records, null, 2);
    await fs.writeFile(this.filePath, serialized, { encoding: 'utf-8' });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const fs = await import('fs/promises');
    const path = await import('path');

    if (!this.filePath) {
      this.filePath = path.resolve(process.cwd(), 'storage/consents/requests.json');
    }

    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    this.initialized = true;
  }
}

export class InMemoryConsentRepository implements ConsentRepository {
  private store = new Map<string, StoredConsentRecord>();

  async save(request: ConsentRequestRecord): Promise<void> {
    const normalized = normalizeRecord(request);
    this.store.set(normalized.requestId, normalized);
  }

  async updateStatus(requestId: string, status: ConsentStatus, updatedAt: number): Promise<void> {
    const record = this.store.get(requestId);
    if (!record) {
      return;
    }
    this.store.set(requestId, {
      ...record,
      status,
      updatedAt,
    });
  }

  async getById(requestId: string): Promise<ConsentRequestRecord | null> {
    const record = this.store.get(requestId);
    return record ? { ...record } : null;
  }

  async listByTarget(targetWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedTarget = normalizeSuiAddress(targetWallet);
    return Array.from(this.store.values())
      .filter((record) => record.targetWallet === normalizedTarget)
      .filter((record) => (status ? record.status === status : true))
      .map((record) => ({ ...record }));
  }

  async listByRequester(requesterWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedRequester = normalizeSuiAddress(requesterWallet);
    return Array.from(this.store.values())
      .filter((record) => record.requesterWallet === normalizedRequester)
      .filter((record) => (status ? record.status === status : true))
      .map((record) => ({ ...record }));
  }

  async delete(requestId: string): Promise<void> {
    this.store.delete(requestId);
  }
}

/**
 * IndexedDBConsentRepository - Browser-compatible implementation
 * Uses IndexedDB for persistent storage in browser environments.
 */
export class IndexedDBConsentRepository implements ConsentRepository {
  private dbName = 'pdw-consent-store';
  private storeName = 'consent-requests';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  constructor(options?: { dbName?: string }) {
    if (options?.dbName) {
      this.dbName = options.dbName;
    }
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'requestId' });
          store.createIndex('targetWallet', 'targetWallet', { unique: false });
          store.createIndex('requesterWallet', 'requesterWallet', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
      };
    });
  }

  async save(request: ConsentRequestRecord): Promise<void> {
    const db = await this.getDB();
    const normalized = normalizeRecord(request);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(normalized);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  async updateStatus(requestId: string, status: ConsentStatus, updatedAt: number): Promise<void> {
    const record = await this.getById(requestId);
    if (!record) {
      return;
    }

    await this.save({
      ...record,
      status,
      updatedAt,
    });
  }

  async getById(requestId: string): Promise<ConsentRequestRecord | null> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(requestId);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const record = req.result as StoredConsentRecord | undefined;
        resolve(record ? { ...record } : null);
      };
    });
  }

  async listByTarget(targetWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedTarget = normalizeSuiAddress(targetWallet);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('targetWallet');
      const req = index.getAll(normalizedTarget);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        let records = req.result as StoredConsentRecord[];
        if (status) {
          records = records.filter((r) => r.status === status);
        }
        resolve(records.map((r) => ({ ...r })));
      };
    });
  }

  async listByRequester(requesterWallet: string, status?: ConsentStatus): Promise<ConsentRequestRecord[]> {
    const normalizedRequester = normalizeSuiAddress(requesterWallet);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const index = store.index('requesterWallet');
      const req = index.getAll(normalizedRequester);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        let records = req.result as StoredConsentRecord[];
        if (status) {
          records = records.filter((r) => r.status === status);
        }
        resolve(records.map((r) => ({ ...r })));
      };
    });
  }

  async delete(requestId: string): Promise<void> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(requestId);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Factory function to create the appropriate ConsentRepository based on environment
 */
export function createConsentRepository(options?: {
  filePath?: string;
  dbName?: string;
  forceInMemory?: boolean;
}): ConsentRepository {
  // Force in-memory for testing
  if (options?.forceInMemory) {
    return new InMemoryConsentRepository();
  }

  // Browser environment - use IndexedDB
  if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
    return new IndexedDBConsentRepository({ dbName: options?.dbName });
  }

  // Node.js environment - use FileSystem (will lazy-load fs/path via import())
  if (typeof window === 'undefined') {
    return new FileSystemConsentRepository({ filePath: options?.filePath });
  }

  // Fallback to in-memory
  return new InMemoryConsentRepository();
}
