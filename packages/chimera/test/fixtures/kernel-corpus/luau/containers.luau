--!strict
-- Container forms: tables, nested tables, array-like tables, method calls.

local Config = {}
Config.defaults = {
	retries = 3,
	timeout = 5000,
	headers = {
		["content-type"] = "application/json",
		accept = "*/*",
	},
}

local registry: { [string]: { number } } = {}

function Config.register(name: string, values: { number })
	registry[name] = values
	return #values
end

function Config.lookup(name: string): { number }?
	return registry[name]
end

local function describe(entry: { number }): string
	local parts = {}
	for i, v in ipairs(entry) do
		table.insert(parts, tostring(v))
	end
	return table.concat(parts, ",")
end

Config.register("primary", { 1, 2, 3 })
local found = Config.lookup("primary")
if found then
	print(describe(found))
end

return Config
