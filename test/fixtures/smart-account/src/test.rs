#![cfg(test)]
extern crate std;

use ed25519_dalek::Signer;
use rand::thread_rng;
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::symbol_short;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, BytesN, Env, IntoVal, Symbol, Vec};

use crate::{AccSignature, SmartAccountContract, SmartAccountContractClient, SmartAccountError};

fn owner_key() -> ed25519_dalek::Keypair {
    ed25519_dalek::Keypair::generate(&mut thread_rng())
}

fn owner_bytesn(e: &Env, kp: &ed25519_dalek::Keypair) -> BytesN<32> {
    kp.public.to_bytes().into_val(e)
}

fn create(env: &Env, cap: i128) -> (SmartAccountContractClient<'_>, ed25519_dalek::Keypair) {
    let kp = owner_key();
    let client = SmartAccountContractClient::new(
        env,
        &env.register(SmartAccountContract {}, (owner_bytesn(env, &kp), cap)),
    );
    (client, kp)
}

fn sign(e: &Env, kp: &ed25519_dalek::Keypair, payload: &BytesN<32>) -> AccSignature {
    AccSignature {
        public_key: owner_bytesn(e, kp),
        signature: kp.sign(payload.to_array().as_slice()).to_bytes().into_val(e),
    }
}

fn transfer_context(e: &Env, token: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: symbol_short!("transfer"),
        args: (Address::generate(e), Address::generate(e), amount).into_val(e),
    })
}

fn check_auth_error(
    env: &Env,
    client: &SmartAccountContractClient<'_>,
    payload: &BytesN<32>,
    signatures: Vec<AccSignature>,
    amount: i128,
) -> SmartAccountError {
    let token = Address::generate(env);
    env.try_invoke_contract_check_auth::<SmartAccountError>(
        &client.address,
        payload,
        signatures.into(),
        &vec![env, transfer_context(env, &token, amount)],
    )
    .err()
    .unwrap()
    .unwrap()
}

#[test]
fn constructor_stores_owner_and_cap() {
    let env = Env::default();
    let kp = owner_key();
    let client = SmartAccountContractClient::new(
        &env,
        &env.register(SmartAccountContract {}, (owner_bytesn(&env, &kp), 500_i128)),
    );
    assert_eq!(client.owner(), Some(owner_bytesn(&env, &kp)));
    assert_eq!(client.spend_cap(), Some(500));
}

#[test]
fn check_auth_accepts_owner_signature() {
    let env = Env::default();
    let (client, kp) = create(&env, -1);
    let payload = BytesN::from_array(&env, &[9u8; 32]);
    let token = Address::generate(&env);
    env.try_invoke_contract_check_auth::<SmartAccountError>(
        &client.address,
        &payload,
        vec![&env, sign(&env, &kp, &payload)].into(),
        &vec![&env, transfer_context(&env, &token, 1000)],
    )
    .unwrap();
}

#[test]
fn check_auth_rejects_wrong_signer() {
    let env = Env::default();
    let (client, _) = create(&env, -1);
    let payload = BytesN::from_array(&env, &[9u8; 32]);
    let impostor = owner_key();
    assert_eq!(
        check_auth_error(&env, &client, &payload, vec![&env, sign(&env, &impostor, &payload)], 1000),
        SmartAccountError::UnknownSigner,
    );
}

#[test]
fn spend_cap_rejects_over_cap_and_allows_inside() {
    let env = Env::default();
    let (client, kp) = create(&env, 500);
    let payload = BytesN::from_array(&env, &[9u8; 32]);

    // 1000 > 500: rejected.
    assert_eq!(
        check_auth_error(&env, &client, &payload, vec![&env, sign(&env, &kp, &payload)], 1000),
        SmartAccountError::SpendCapExceeded,
    );

    // 500 <= 500: accepted.
    env.try_invoke_contract_check_auth::<SmartAccountError>(
        &client.address,
        &payload,
        vec![&env, sign(&env, &kp, &payload)].into(),
        &vec![&env, transfer_context(&env, &Address::generate(&env), 500)],
    )
    .unwrap();
}

#[test]
fn unlimited_cap_accepts_any_amount() {
    let env = Env::default();
    let (client, kp) = create(&env, -1);
    let payload = BytesN::from_array(&env, &[9u8; 32]);
    env.try_invoke_contract_check_auth::<SmartAccountError>(
        &client.address,
        &payload,
        vec![&env, sign(&env, &kp, &payload)].into(),
        &vec![&env, transfer_context(&env, &Address::generate(&env), 1_000_000)],
    )
    .unwrap();
}
