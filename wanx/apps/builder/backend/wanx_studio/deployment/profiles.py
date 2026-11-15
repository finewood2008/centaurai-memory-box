"""Route verified releases and runtime slots to their installed box profile."""
from .adapters import Blocked
from .expert_profile import PROFILE as EXPERT_PROFILE
from .miniapp_profile import PROFILE as MINIAPP_PROFILE
from ..contracts import StudioError


class DeploymentProfiles:
    supported_actions = ['deploy']

    def __init__(self, miniapp, expert):
        self.miniapp,self.expert=miniapp,expert
        expert.other_profile=miniapp

    @property
    def available(self):
        return self.miniapp.available or self.expert.available

    def release_profile(self, bundle):
        profile=bundle.get('runtimeRequirements',{}).get('runtimeRef',{}).get('id') if bundle else None
        if profile==EXPERT_PROFILE:return self.expert
        if profile==MINIAPP_PROFILE:return self.miniapp
        raise Blocked('RUNTIME_INCOMPATIBLE')

    def operation_profile(self, operation, bundle=None):
        if bundle:return self.release_profile(bundle)
        ref=operation['request'].get('decisionRef',{}).get('id')
        if ref and self.expert.get('preparation',ref):return self.expert
        return self.miniapp

    async def authorize(self, owner, target, action):
        # A target check grants no profile execution. Release provenance and the
        # selected profile's explicit startup authority are checked separately.
        usable=self.miniapp if self.miniapp.available else self.expert
        return await usable.authorize(owner,target,action)

    async def verify_release(self, owner, bundle):
        return await self.release_profile(bundle).verify_release(owner,bundle)

    async def check(self, operation, bundle, phase):
        return await self.operation_profile(operation,bundle).check(operation,bundle,phase)

    async def inspect(self, step, operation, bundle):
        return await self.operation_profile(operation,bundle).inspect(step,operation,bundle)

    async def execute(self, step, operation, bundle):
        return await self.operation_profile(operation,bundle).execute(step,operation,bundle)

    async def deliver(self, receipt):
        # All profiles share this durable sink; outbox delivery does not require
        # an editor session or an available miniapp execution profile.
        return await self.miniapp.deliver(receipt)

    def context(self, owner, project_id):
        return self.miniapp.context(owner,project_id)

    async def prepare(self, owner, project_id, body):
        # Existing project deployments cannot take over a directory-owned slot.
        self.miniapp.authorize_owner(owner)
        if not isinstance(body,dict):raise StudioError('DEPLOYMENT_PREPARATION_INVALID',422)
        p=self.miniapp.svc.store.get(owner,project_id)
        target=self.miniapp.target_for(owner,p['appId'],body.get('environment'))
        if self.expert.get('binding',self.expert.slot_key(owner,target)):
            raise StudioError('RUNTIME_INCOMPATIBLE',409)
        return await self.miniapp.prepare(owner,project_id,body)

    async def submit(self, owner, project_id, body):
        return await self.miniapp.submit(owner,project_id,body)

    def find_binding(self, owner, slot):
        matches=[p.find_binding(owner,slot) for p in (self.miniapp,self.expert)]
        matches=[value for value in matches if value is not None]
        if len(matches)>1:raise StudioError('DEPLOYMENT_SLOT_CONFLICT',409)
        return matches[0] if matches else None

    def slot_id(self, owner, target):
        return self.miniapp.slot_id(owner,target)

    def slot_profile(self, owner, slot):
        self.find_binding(owner,slot)
        if self.expert.find_binding(owner,slot):return self.expert
        return self.miniapp

    def assert_runtime(self, session):
        if session.get('deploymentSlot'):
            self.slot_profile(session['owner'],session['deploymentSlot']).assert_runtime(session)

    def open_runtime(self, owner, slot, body):
        return self.slot_profile(owner,slot).open_runtime(owner,slot,body)

    def ticket_profile(self, owner, ticket_id):
        for profile in (self.miniapp,self.expert):
            ticket=profile.get('ticket',ticket_id)
            if ticket and ticket['owner']==owner:return profile
        raise StudioError('DEPLOYMENT_DELIVERY_NOT_FOUND',404)

    def delivery_list(self, owner):
        items=[]
        for profile in (self.miniapp,self.expert):
            if profile.available:items.extend(profile.delivery_list(owner)['items'])
        return {'items':items[:100]}

    def delivery_claim(self, owner, ticket_id, body):
        return self.ticket_profile(owner,ticket_id).delivery_claim(owner,ticket_id,body)

    def delivery_payload(self, owner, ticket_id):
        return self.ticket_profile(owner,ticket_id).delivery_payload(owner,ticket_id)

    def delivery_ack(self, owner, ticket_id, body):
        return self.ticket_profile(owner,ticket_id).delivery_ack(owner,ticket_id,body)

    def close(self):
        self.miniapp.close();self.expert.close()
