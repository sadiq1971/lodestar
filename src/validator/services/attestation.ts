/**
 * @module validator/attestation
 */
import {
  Attestation,
  AttestationData,
  AttestationDataAndCustodyBit,
  Fork,
  Shard,
  Slot,
  ValidatorIndex
} from "../../types";
import {RpcClient} from "../rpc";
import {PrivateKey} from "@chainsafe/bls-js/lib/privateKey";
import {hashTreeRoot} from "@chainsafe/ssz";
import {getDomainFromFork, isSlashableAttestationData, slotToEpoch} from "../../chain/stateTransition/util";
import {Domain} from "../../constants";
import logger from "../../logger";
import {intDiv} from "../../util/math";
import {IValidatorDB} from "../../db/api";

export class AttestationService {

  private validatorIndex: ValidatorIndex;
  private rpcClient: RpcClient;
  private privateKey: PrivateKey;
  private db: IValidatorDB;

  public constructor(
    validatorIndex: ValidatorIndex,
    rpcClient: RpcClient,
    privateKey: PrivateKey,
    db: IValidatorDB
  ) {
    this.validatorIndex = validatorIndex;
    this.rpcClient = rpcClient;
    this.privateKey = privateKey;
    this.db = db;
  }


  public async createAndPublishAttestation(slot: Slot, shard: Shard, fork: Fork): Promise<Attestation> {
    const attestationData = await this.rpcClient.validator.produceAttestation(slot, shard);
    if (await this.isConflictingAttestation(attestationData)) {
      logger.warn(
        `[Validator] Avoided signing conflicting attestation! `
        + `Source epoch: ${attestationData.sourceEpoch}, Target epoch: ${slotToEpoch(slot)}`
      );
      return null;
    }
    const attestationDataAndCustodyBit: AttestationDataAndCustodyBit = {
      custodyBit: false,
      data: attestationData
    };
    const attestation = await this.createAttestation(attestationDataAndCustodyBit, fork, slot);
    await this.storeAttestation(attestation);
    await this.rpcClient.validator.publishAttestation(attestation);
    logger.info(`[Validator] Signed and publish new attestation`);
    return attestation;
  }

  private async isConflictingAttestation(other: AttestationData): Promise<boolean> {
    const potentialAttestationConflicts = await this.db.getAttestations(this.validatorIndex, {gt: other.targetEpoch - 1});
    return potentialAttestationConflicts.some((attestation => {
      return isSlashableAttestationData(attestation.data, other);
    }));
  }

  private async storeAttestation(attestation: Attestation): Promise<void> {
    await this.db.setAttestation(this.validatorIndex, attestation);

    //cleanup
    const unusedAttestations = await this.db.getAttestations(this.validatorIndex, {gt: 0, lt: attestation.data.targetEpoch});
    await this.db.deleteAttestations(this.validatorIndex, unusedAttestations);
  }

  private async createAttestation(
    attestationDataAndCustodyBit: AttestationDataAndCustodyBit,
    fork: Fork,
    slot: Slot
  ): Promise<Attestation> {
    const signature = this.privateKey.signMessage(
      hashTreeRoot(attestationDataAndCustodyBit, AttestationDataAndCustodyBit),
      getDomainFromFork(
        fork,
        slotToEpoch(slot),
        Domain.ATTESTATION
      )
    ).toBytesCompressed();
    const committeeAssignment =
      await this.rpcClient.validator.getCommitteeAssignment(this.validatorIndex, slotToEpoch(slot));
    const indexInCommittee =
      committeeAssignment.validators
        .findIndex(value => value === this.validatorIndex);
    const aggregationBitfield = Buffer.alloc(committeeAssignment.validators.length + 7, 0);
    aggregationBitfield[intDiv(indexInCommittee, 8)] = Math.pow(2, indexInCommittee % 8);
    return {
      data: attestationDataAndCustodyBit.data,
      signature,
      custodyBitfield: Buffer.alloc(committeeAssignment.validators.length + 7, 0),
      aggregationBitfield
    };
  }
}
