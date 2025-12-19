import { describe, it, expect, beforeEach } from '@jest/globals';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  FileSystemConsentRepository,
  InMemoryConsentRepository,
  type ConsentRepository,
} from '../../src/permissions/ConsentRepository';
import type { ConsentRequestRecord } from '../../src/types/wallet';

const SAMPLE_REQUEST: ConsentRequestRecord = {
  requesterWallet: '0xabc1230000000000000000000000000000000001',
  targetWallet: '0xabc1230000000000000000000000000000000002',
  targetScopes: ['read:memories'],
  purpose: 'demo access',
  expiresAt: undefined,
  requestId: 'request-demo',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  status: 'pending',
};

async function createFileRepository(): Promise<{ repo: ConsentRepository; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pdw-consents-'));
  const filePath = join(dir, 'requests.json');
  const repo = new FileSystemConsentRepository({ filePath });
  return { repo, filePath };
}

describe('ConsentRepository implementations', () => {
  const repositoriesFactory = [
    {
      name: 'FileSystemConsentRepository',
      create: async () => {
        const { repo } = await createFileRepository();
        return repo;
      },
    },
    {
      name: 'InMemoryConsentRepository',
      create: async () => new InMemoryConsentRepository(),
    },
  ];

  for (const factory of repositoriesFactory) {
    describe(factory.name, () => {
      let repo: ConsentRepository;

      beforeEach(async () => {
        repo = await factory.create();
      });

      it('saves and retrieves consent requests', async () => {
        await repo.save(SAMPLE_REQUEST);

        const pendingForTarget = await repo.listByTarget(SAMPLE_REQUEST.targetWallet, 'pending');
        expect(pendingForTarget).toHaveLength(1);
        expect(pendingForTarget[0]).toMatchObject({
          requesterWallet: normalizeSuiAddress(SAMPLE_REQUEST.requesterWallet),
          targetWallet: normalizeSuiAddress(SAMPLE_REQUEST.targetWallet),
          status: 'pending',
        });

        const pendingForRequester = await repo.listByRequester(SAMPLE_REQUEST.requesterWallet, 'pending');
        expect(pendingForRequester).toHaveLength(1);
        expect(pendingForRequester[0].requesterWallet).toBe(
          normalizeSuiAddress(SAMPLE_REQUEST.requesterWallet),
        );
      });

      it('updates status for stored consents', async () => {
        await repo.save(SAMPLE_REQUEST);

        await repo.updateStatus(SAMPLE_REQUEST.requestId, 'approved', Date.now());

        const approved = await repo.listByRequester(SAMPLE_REQUEST.requesterWallet, 'approved');
        expect(approved).toHaveLength(1);
        expect(approved[0].status).toBe('approved');
      });

      it('deletes stored consents', async () => {
        const customRequest: ConsentRequestRecord = {
          ...SAMPLE_REQUEST,
          requestId: randomUUID(),
        };
        await repo.save(customRequest);

        await repo.delete(customRequest.requestId);
        const remaining = await repo.listByRequester(SAMPLE_REQUEST.requesterWallet);
        expect(remaining).not.toEqual(expect.arrayContaining([expect.objectContaining({ requestId: customRequest.requestId })]));
      });
    });
  }

  it('writes JSON file compatible structure', async () => {
    const { repo, filePath } = await createFileRepository();
    await repo.save(SAMPLE_REQUEST);

    const fileContents = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(fileContents);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].requestId).toBe(SAMPLE_REQUEST.requestId);
  });
});
