--!strict
-- Import and type forms: require, type aliases, exported types, typed locals.

local Http = require("./http")
local Json = require("@pkg/json")

export type Response = {
	status: number,
	body: string,
	headers: { [string]: string }?,
}

type Parser = (input: string) -> (Response?, string?)

local function parseRaw(input: string): (Response?, string?)
	local decoded = Json.decode(input)
	if typeof(decoded) ~= "table" then
		return nil, "not a table"
	end
	return {
		status = decoded.status or 0,
		body = decoded.body or "",
	}, nil
end

local parser: Parser = parseRaw

function fetch(url: string): Response?
	local raw = Http.get(url)
	local parsed, err = parser(raw)
	if err then
		warn(err)
		return nil
	end
	return parsed
end

local response = fetch("https://example.com/data")
if response then
	print(response.status, #response.body)
end
