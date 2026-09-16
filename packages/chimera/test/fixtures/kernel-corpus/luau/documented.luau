--- Documented module: docstrings on variables, functions, and types.
-- Exercises the comment-marker normalization family.
local M = {}

--- Build a greeting for the given name.
-- @param name string -- who to greet
-- @return string -- the greeting text
function M.greet(name: string): string
	return "hello, " .. name
end

--- Cached greeting count.
local count = 0

--- Increment and return the running greeting count.
function M.tally(): number
	count += 1
	return count
end

--[[ Block-documented type:
	a pair of numbers. ]]
export type Pair = { first: number, second: number }

--- Sum a Pair.
function M.sum(pair: Pair): number
	return pair.first + pair.second
end

local greeting = M.greet("world")
print(greeting, M.tally(), M.sum({ first = 1, second = 2 }))

return M
