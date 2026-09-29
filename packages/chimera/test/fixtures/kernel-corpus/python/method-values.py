# Python member values preserve receivers (upstream #2034 kernel-parity
# fixture, fork corpus copy): callback, assignment, collection, keyword and
# call positions.
class Store:
    def fetch(self, ids):
        return ids
class Consumer:
    def wire(self, pool, obj):
        pool.submit(self.store.fetch, obj.fetch)
        cb = self.store.fetch
        table = [obj.fetch, Store.fetch, self.fetch, cls.fetch]
        keyword(callback=obj.fetch)
        obj.fetch([])
        pool.submit(factory().fetch, obj[0].fetch)
