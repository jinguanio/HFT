var evt = require('events').EventEmitter;
var _ = require("underscore")._;
var ById = {}; 
var Order = {
	bookId: null, 
    ticker: null, 
	type: null,
    buy: true,
	size: null, 
	price: null, 
    limit: function(curr_price) {
		var f, res={};
		f = this.buy ? 1 : -1;
	    if (this.price*f >=curr_price*f){
			 res = this.execute(curr_price);
		} else {
		     res[this.ticker] = 0;
			 res.cash = 0;
		}

		return res
	}, 
	stop: function(curr_price) {
        var f, res={}; 	
		f = this.buy ? 1 : -1;
		if (this.price*f <= curr_price*f){
	        res = this.execute(curr_price);	
		} else {
		    res[this.ticker] = 0;
			res.cash = 0;
		} 
		return res
	}, 
	market: function(curr_price){
        return this.execute(curr_price);    	
	},
	execute: function(price){
		var f = this.buy ? 1 : -1, res={}, cc;
		res.shares = this.size * f; 
		res.buy = this.buy;
		res.cash = price * this.size * -1 * f;
		cc = this.commission();
		res.cash -= cc;
		res.price = price
		res.commission = cc;
		res.ticker = this.ticker;
		this.destroy("filled");
		return res
	}, 
	destroy: function(status){
		if (!status){
		    status = "canceled"
		} else {
		    status = "filled"
		}
		var self = this, book;
		book = ById[this.bookId];
        book.emit("destory", { order: self, status: status, id: self.id });    	
		for (k in self){
		    delete self[k]
		}
	}, 
	commission: function(){
        return 4	
	}
};

var OrderBook = new evt;

_.extend(OrderBook, {
    
	init: function(portId){
		var id; 
		id = _.uniqueId("OrderBook_");
		ById[id] = this;
		this.id = id;
	    this.portfolioId = portId;
		this.byOrderId = {};
		this.orders = [];
		this.count = 0;
		this.on("neworder", function(order){
			// max number of pending orders
			if (this.orders.length>100) return this;
			order.bookId = this.id;
			order.id = order.tracker || _.uniqueId("Order_"); 
		    this.orders.unshift(order);
			this.count ++;
			this.byOrderId[order.id] = order;
			return this;
		});
		this.on("destory", function(msg){
		    var i = this.orders.lastIndexOf(msg.order);
			if (i>-1) {
				this.orders.splice(i, 1);
				this.count --;
				delete this.byOrderId[String(msg.id)]
			}
		});

		this.on("cancel_order", this.cancel);

		return this;
	
	},

	process: function(prices){
		var i, order, act, res, price;
	    for (i in this.orders){
		    order = this.orders[i];    
			act = order.type.toLowerCase();
			price = prices[order.ticker];
			try {
			    res = order[act](price);
			} catch (err){
			    res = undefined;
			}
			if (res.ticker) {
			    this.portfolio().emit("order_filled", res);
			}
		}
	}, 

	cancel: function(orderId) { 
	    var order = this.byOrderId[orderId];
		if (order) {
		    order.destroy();
		}

		return orderId
	}, 

	portfolio: function(){
        return (ById[this.portfolioId])	
	}


});

var Portfolio = new evt;

_.extend(Portfolio, {
    
	tickers: null, 

    config : {
	    fetch_interval : 5000, 
		max_size: 10, 
	    cash_init: 1000000
	}, 

	init: function(tickers, config, position) {
		var name, pos, id;
		id = _.uniqueId("Portfolio_");
		ById[id] = this;
		this.id = id;
		if (config) _.extend(this.config, config);
	    if (tickers) {
			this.addTicker(tickers);
		} else {
		    this.tickers = [];
		}

		if (!position) {
		    this.position = { cash: this.config.cash_init }
		} else {
			this.position = {};
	        for (name in position){
			    if ((this.tickers.indexOf(name) > -1 || 
					 name == "cash") && 
					typeof (pos = position[name]) == "number"){
				    this.position[name] = pos
				}    
			}	
		}

		this.LastPrice = {};
		this.orderBook = Object.create(OrderBook).init(id);
		this.on("order_filled", this.orderFilled);
		this.on("incoming_order", this.processOrder);
		this.on("cancel_order", this.cancel);


		return this
	}, 

	addTicker: function(tickers){
		tickers = tickers instanceof Array ? tickers : [tickers];
		var i, ticker;
		for (i in tickers){
			ticker = tickers[i].toUpperCase();
		    if (this.tickers.indexOf(ticker) == -1 &&
				this.tickers.length < this.config.max_size) {
	            this.tickers.unshift(ticker);
				this.position[ticker] = 0;
		    }
		}
        
		this.emit("change", {
		    event: "tickersadded", 
			port : this, 
			data : tickers 
		});
        
		return this
	}, 

	removeTicker: function(tickers) {
		var i, j, ticker; 
		tickers = tickers instanceof Array ? tickers : [tickers];
		for (j in tickers){
			ticker = tickers[j];
            i = this.tickers.indexOf(ticker);	
		    if (i > -1) {
	            this.tickers.splice(i, 1);	
				delete this.position[ticker];
		    }
		}

		this.emit("change", {
		    event: "tickersremoved", 
			port : this, 
			data : tickers 
		});

		return this
	},

	priceUpdate: function(price_obj) {
        var i, ticker, price, prices={};
		for (i in this.tickers){
		    ticker = this.tickers[i];
			price = Number(price_obj[ticker]);
			// the price_obj does not cover the complete price info
            if (!price || isNaN(price)) {
				return this
			}
			prices[ticker] = price 
		}
        
		this.orderBook.process(prices);
		_.extend(this.LastPrice, prices);

		this.emit("change", {
		    event: "pricechange", 
			port : this, 
			data : prices
		});


		return this
	}, 

	processOrder: function(order_string){
		if (typeof order_string == "string") {
			try {
				// BUY 200 AAPL@600 LIMIT
                var a = order_string.split(/\s+/), 
			        buy = a[0].toLowerCase(),
					type = a[3].toUpperCase(), 
					ticker = a[2].split("@"), 
					size = Number(a[1]), 
					price = Number(ticker[1]), 
					order;

				ticker = ticker[0].toUpperCase();
				order = createOrder({
				    buy : buy == "buy",
					type : type, 
					ticker : ticker, 
					size: size, 
					price : price 
				}); 

				this.orderBook.emit("neworder", order);
			} catch(err) {
			    // handler parse errors
			}
		} else if (order_string instanceof Object){
			var order = createOrder(order_string);
			this.orderBook.emit("neworder", order);

		}

		this.emit("change", {
		    event: "neworder", 
		    port : this, 
		    data : order
		});

		return this
	}, 

	orderFilled: function(msg) {
	    this.position[msg.ticker] += msg.shares;
		this.position.cash += msg.cash;
		this.emit("change", {
		    event: "orderfilled", 
			data : msg, 
			port : this
		});
	}, 

	cancel : function(orderId) {

        this.orderBook.cancel(orderId);

		this.emit("change", {
		    event: "order_canceled", 
			data : orderId, 
			port : this
		});

	}

});

var createOrder = function(details){
    var o = Object.create(Order);
	_.extend(o, details);
	return o
};

_.extend(exports, {

	ById : ById, 

    Portfolio : Portfolio,

	Order: Order,

	OrderBook: OrderBook, 

	createPort: function(tickers, config, position){

	    return (Object.create(this.Portfolio)
				.init(tickers, 
					  config, 
					  position))
	}, 

	createOrder: createOrder

});
