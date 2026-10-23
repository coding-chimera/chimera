#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol NNPaying <NSObject>
@property (nonatomic, copy) NSString *account;
- (BOOL)payAmount:(NSInteger)amount;
@end

@interface NNCustomer : NSObject <NNPaying>
@property (nonatomic, copy) NSString *name;
- (instancetype)initWithName:(NSString *)name;
+ (instancetype)customerNamed:(NSString *)name;
- (nullable NNCustomer *)referrer;
@end

NS_ASSUME_NONNULL_END

@implementation NNCustomer

- (instancetype)initWithName:(NSString *)name {
    self = [super init];
    if (self) {
        _name = [name copy];
    }
    return self;
}

+ (instancetype)customerNamed:(NSString *)name {
    return [[self alloc] initWithName:name];
}

- (BOOL)payAmount:(NSInteger)amount {
    return amount > 0;
}

- (nullable NNCustomer *)referrer {
    return nil;
}

@end