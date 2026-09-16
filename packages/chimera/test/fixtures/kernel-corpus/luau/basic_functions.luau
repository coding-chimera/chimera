--!strict
-- Basic function forms: global, local, typed params, multiple returns.

local function clamp(value: number, low: number, high: number): number
	if value < low then
		return low
	end
	if value > high then
		return high
	end
	return value
end

function scaleAll(values: { number }, factor: number): { number }
	local out = {}
	for _, v in ipairs(values) do
		table.insert(out, v * factor)
	end
	return out
end

local function minMax(values: { number }): (number, number)
	local lo, hi = values[1], values[1]
	for _, v in ipairs(values) do
		if v < lo then
			lo = v
		end
		if v > hi then
			hi = v
		end
	end
	return lo, hi
end

function normalize(values: { number }): { number }
	local lo, hi = minMax(values)
	local span = hi - lo
	if span == 0 then
		return values
	end
	return scaleAll(values, 1 / span)
end

local limited = clamp(12, 0, 10)
print(limited, limited + 1)
