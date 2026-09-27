import { Account, Address, Keypair, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

// Test-only builders for signed-shape Soroban invocations. Not imported by
// production code.

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const KNOWN_WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const SECOND_WALLET = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";

export interface AuthSpec {
  subject: string;
  nonce: string;
  expirationLedger?: number;
  /** Credential arm; passkey-kit@0.14 emits V2 in production. */
  variant?: "v1" | "v2";
}

export interface EnvelopeSpec {
  /** Envelope source; defaults to a random account (the sponsor discards it). */
  source?: string;
  sequence?: string;
  fee?: string;
  functionName?: string;
}

function authEntry(spec: AuthSpec): xdr.SorobanAuthorizationEntry {
  const addr = Address.fromString(spec.subject);
  const creds = new xdr.SorobanAddressCredentials({
    address: addr.toScAddress(),
    nonce: xdr.Int64.fromString(spec.nonce),
    signatureExpirationLedger: spec.expirationLedger ?? 1_000,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      spec.variant === "v2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(creds)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: addr.toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** A signed-shape invokeHostFunction tx carrying the given address-credential
 * auth entries, wrapped in an arbitrary envelope. */
export function buildInvokeTx(auth: AuthSpec[], envelope: EnvelopeSpec = {}): string {
  const target = Address.fromString(auth[0]?.subject ?? KNOWN_WALLET);
  const account = new Account(
    envelope.source ?? Keypair.random().publicKey(),
    envelope.sequence ?? "0",
  );
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: target.toScAddress(),
        functionName: envelope.functionName ?? "transfer",
        args: [],
      }),
    ),
    auth: auth.map(authEntry),
  });
  return new TransactionBuilder(account, {
    fee: envelope.fee ?? "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toXDR();
}
