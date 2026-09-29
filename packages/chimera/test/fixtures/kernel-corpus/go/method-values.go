// Go method values preserve receivers and exclude invocation receivers
// (upstream #2034 kernel-parity fixture, fork corpus copy).
package demo

type Store struct{}

func (s *Store) Fetch() {}

func wire(c *Store, pool Pool) {
	Submit(c.Fetch)
	cb := c.Fetch
	table := []func(){c.Fetch, Store.Fetch}
	Submit(c.store.Fetch)
	go c.Fetch()
	Submit(factory().Fetch, items[0].Fetch)
}
