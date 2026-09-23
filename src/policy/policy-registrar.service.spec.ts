import { Logger } from '@nestjs/common';
import { PolicyRegistrarService } from './policy-registrar.service';
import { PolicyLoaderService } from './policy-loader.service';
import { AuthTokenMinterService } from '../auth/auth-token-minter.service';
import { AppConfigService } from '../config/app-config.service';
import type { PolicyDefinition } from '../contracts/policy';

const registerPolicyMock = jest.fn();
const getPolicyMock = jest.fn();
const macpClientCtor = jest.fn();

jest.mock('macp-sdk-typescript', () => ({
  Auth: {
    bearer: (token: string, options?: { expectedSender?: string }) => ({
      bearerToken: token,
      expectedSender: options?.expectedSender
    })
  },
  MacpClient: jest.fn().mockImplementation((opts: unknown) => {
    macpClientCtor(opts);
    return { registerPolicy: registerPolicyMock, getPolicy: getPolicyMock };
  })
}));

const claimsPolicy: PolicyDefinition = {
  policy_id: 'policy.claims.majority',
  mode: 'macp.mode.decision.v1',
  schema_version: 3,
  description: 'Claims majority',
  rules: {
    voting: { algorithm: 'majority', threshold: 0.5, quorum: { type: 'count', value: 2 } },
    objection_handling: { critical_severity_vetoes: false, veto_threshold: 1 },
    evaluation: { minimum_confidence: 0, required_before_voting: false },
    commitment: { authority: 'initiator_only', require_vote_quorum: true, designated_roles: [] }
  }
};

const fraudPolicy: PolicyDefinition = {
  ...claimsPolicy,
  policy_id: 'policy.fraud.unanimous',
  description: 'Fraud unanimous'
};

function buildService(
  overrides: {
    registerPoliciesOnLaunch?: boolean;
    runtimeAddress?: string;
    policies?: PolicyDefinition[];
    mint?: () => Promise<{
      token: string;
      sender: string;
      expiresAt: number;
      expiresInSeconds: number;
      cacheOutcome: 'hit' | 'miss';
    }>;
  } = {}
) {
  const config = {
    registerPoliciesOnLaunch: overrides.registerPoliciesOnLaunch ?? true,
    runtimeAddress: overrides.runtimeAddress ?? 'runtime:50051',
    runtimeTls: false,
    runtimeAllowInsecure: true
  } as unknown as AppConfigService;

  const loader = {
    listRegistrablePolicies: jest.fn().mockReturnValue(overrides.policies ?? [claimsPolicy, fraudPolicy])
  } as unknown as PolicyLoaderService;

  const minter = {
    mintToken:
      overrides.mint ??
      jest.fn().mockResolvedValue({
        token: 'jwt-admin',
        sender: 'macp-playground',
        expiresAt: Date.now() + 3_600_000,
        expiresInSeconds: 3600,
        cacheOutcome: 'miss'
      })
  } as unknown as AuthTokenMinterService;

  return { service: new PolicyRegistrarService(config, loader, minter), config, loader, minter };
}

describe('PolicyRegistrarService', () => {
  beforeEach(() => {
    registerPolicyMock.mockReset();
    getPolicyMock.mockReset();
    macpClientCtor.mockReset();
  });

  it('skips when registerPoliciesOnLaunch is false', async () => {
    const { service, minter } = buildService({ registerPoliciesOnLaunch: false });
    await service.onApplicationBootstrap();
    expect(minter.mintToken).not.toHaveBeenCalled();
    expect(macpClientCtor).not.toHaveBeenCalled();
  });

  it('skips when runtime address is unset', async () => {
    const { service, minter } = buildService({ runtimeAddress: '' });
    await service.onApplicationBootstrap();
    expect(minter.mintToken).not.toHaveBeenCalled();
  });

  it('skips when no registrable policies are loaded', async () => {
    const { service, minter } = buildService({ policies: [] });
    await service.onApplicationBootstrap();
    expect(minter.mintToken).not.toHaveBeenCalled();
  });

  it('aborts cleanly when minting fails', async () => {
    const { service } = buildService({
      mint: jest.fn().mockRejectedValue(new Error('auth-service down'))
    });
    await service.onApplicationBootstrap();
    expect(macpClientCtor).not.toHaveBeenCalled();
    expect(registerPolicyMock).not.toHaveBeenCalled();
  });

  it('mints with management scope for the macp-playground sender', async () => {
    const { service, minter } = buildService();
    registerPolicyMock.mockResolvedValue({ ok: true });
    await service.onApplicationBootstrap();
    expect(minter.mintToken).toHaveBeenCalledWith('macp-playground', {
      can_manage_mode_registry: true,
      is_observer: false,
      allowed_modes: ['*']
    });
  });

  it('constructs MacpClient with runtime address and bearer auth', async () => {
    const { service } = buildService();
    registerPolicyMock.mockResolvedValue({ ok: true });
    await service.onApplicationBootstrap();
    expect(macpClientCtor).toHaveBeenCalledWith({
      address: 'runtime:50051',
      secure: false,
      allowInsecure: true,
      auth: { bearerToken: 'jwt-admin', expectedSender: 'macp-playground' }
    });
  });

  it('maps PolicyDefinition fields and stringifies rules into PolicyDescriptor', async () => {
    const { service } = buildService({ policies: [claimsPolicy] });
    registerPolicyMock.mockResolvedValue({ ok: true });
    await service.onApplicationBootstrap();
    expect(registerPolicyMock).toHaveBeenCalledTimes(1);
    expect(registerPolicyMock).toHaveBeenCalledWith({
      policyId: 'policy.claims.majority',
      mode: 'macp.mode.decision.v1',
      description: 'Claims majority',
      rules: JSON.stringify(claimsPolicy.rules),
      schemaVersion: 3
    });
  });

  it('registers every policy returned by the loader', async () => {
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock.mockResolvedValue({ ok: true });
    await service.onApplicationBootstrap();
    expect(registerPolicyMock).toHaveBeenCalledTimes(2);
  });

  it('treats "already registered" errors as success and continues', async () => {
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock
      .mockResolvedValueOnce({ ok: false, error: 'policy with id policy.claims.majority already exists' })
      .mockResolvedValueOnce({ ok: true });
    await service.onApplicationBootstrap();
    expect(registerPolicyMock).toHaveBeenCalledTimes(2);
  });

  it('continues registering remaining policies when one throws', async () => {
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock.mockRejectedValueOnce(new Error('grpc UNAVAILABLE')).mockResolvedValueOnce({ ok: true });
    await service.onApplicationBootstrap();
    expect(registerPolicyMock).toHaveBeenCalledTimes(2);
  });

  it('switches to verification when the registry is read-only (result error) and all policies are present', async () => {
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock.mockResolvedValueOnce({
      ok: false,
      error: 'FAILED_PRECONDITION: policy registry is read-only (MACP_POLICIES_DIR)'
    });
    getPolicyMock.mockImplementation((policyId: string) => Promise.resolve({ policyId, schemaVersion: 3 }));

    await service.onApplicationBootstrap();

    // Only the first policy hits registerPolicy; after the read-only signal we
    // never attempt another mutation.
    expect(registerPolicyMock).toHaveBeenCalledTimes(1);
    // Both policies are verified via getPolicy (the trigger one + the remainder).
    expect(getPolicyMock).toHaveBeenCalledTimes(2);
    expect(getPolicyMock).toHaveBeenCalledWith('policy.claims.majority');
    expect(getPolicyMock).toHaveBeenCalledWith('policy.fraud.unanimous');
  });

  it('switches to verification when registerPolicy throws FAILED_PRECONDITION', async () => {
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock.mockRejectedValueOnce(new Error('13 FAILED_PRECONDITION: registry is file-managed'));
    getPolicyMock.mockImplementation((policyId: string) => Promise.resolve({ policyId, schemaVersion: 3 }));

    await service.onApplicationBootstrap();

    expect(registerPolicyMock).toHaveBeenCalledTimes(1);
    expect(getPolicyMock).toHaveBeenCalledTimes(2);
  });

  it('logs missing policies (ERROR) when read-only and getPolicy rejects NOT_FOUND', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = buildService({ policies: [claimsPolicy, fraudPolicy] });
    registerPolicyMock.mockResolvedValueOnce({ ok: false, error: 'FAILED_PRECONDITION: read-only registry' });
    getPolicyMock
      .mockResolvedValueOnce({ policyId: 'policy.claims.majority', schemaVersion: 3 }) // present
      .mockRejectedValueOnce(new Error('NOT_FOUND: no such policy')); // missing

    await service.onApplicationBootstrap();

    expect(getPolicyMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('policy.fraud.unanimous.json');
    errorSpy.mockRestore();
  });

  describe('schema_version drift detection', () => {
    it('flags a runtime holding a stale schema_version behind an "already registered" response', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service } = buildService({ policies: [claimsPolicy] });
      registerPolicyMock.mockResolvedValueOnce({
        ok: false,
        error: 'policy with id policy.claims.majority already exists'
      });
      getPolicyMock.mockResolvedValueOnce({ policyId: 'policy.claims.majority', schemaVersion: 1 });

      await service.onApplicationBootstrap();

      expect(getPolicyMock).toHaveBeenCalledWith('policy.claims.majority');
      // One error line per drifted policy, plus one summary error line.
      expect(errorSpy).toHaveBeenCalledTimes(2);
      const message = errorSpy.mock.calls[0][0] as string;
      expect(message).toContain('policy_schema_drift');
      expect(message).toContain('policy.claims.majority');
      expect(message).toContain('runtime_schema_version=1');
      expect(message).toContain('local_schema_version=3');
      errorSpy.mockRestore();
    });

    it('does not flag drift when the "already registered" runtime copy matches the local schema_version', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service } = buildService({ policies: [claimsPolicy] });
      registerPolicyMock.mockResolvedValueOnce({
        ok: false,
        error: 'policy with id policy.claims.majority already exists'
      });
      getPolicyMock.mockResolvedValueOnce({ policyId: 'policy.claims.majority', schemaVersion: 3 });

      await service.onApplicationBootstrap();

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('flags drift on the read-only verification path too', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service } = buildService({ policies: [claimsPolicy] });
      registerPolicyMock.mockResolvedValueOnce({
        ok: false,
        error: 'FAILED_PRECONDITION: policy registry is read-only (MACP_POLICIES_DIR)'
      });
      getPolicyMock.mockResolvedValueOnce({ policyId: 'policy.claims.majority', schemaVersion: 2 });

      await service.onApplicationBootstrap();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('policy_schema_drift'));
      errorSpy.mockRestore();
    });

    it('logs a summary error line when any policy has schema drift', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service } = buildService({ policies: [claimsPolicy] });
      registerPolicyMock.mockResolvedValueOnce({
        ok: false,
        error: 'policy with id policy.claims.majority already exists'
      });
      getPolicyMock.mockResolvedValueOnce({ policyId: 'policy.claims.majority', schemaVersion: 1 });

      await service.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('schema_drift=1'));
      logSpy.mockRestore();
    });

    it('does not throw when the schema-drift follow-up getPolicy call itself fails', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = buildService({ policies: [claimsPolicy] });
      registerPolicyMock.mockResolvedValueOnce({
        ok: false,
        error: 'policy with id policy.claims.majority already exists'
      });
      getPolicyMock.mockRejectedValueOnce(new Error('grpc UNAVAILABLE'));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('policy_schema_drift_check_failed'));
      warnSpy.mockRestore();
    });
  });
});
