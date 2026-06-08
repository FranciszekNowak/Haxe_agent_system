-- Allow NULL temperature for models that don't support the parameter
alter table model_routing alter column temperature drop not null;

-- claude-opus-4-8 deprecated the temperature parameter (2026-06-08)
update model_routing set temperature = null where litellm_model = 'haxe-opus-4-8-direct';
