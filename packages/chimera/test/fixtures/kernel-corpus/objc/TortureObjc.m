#import <Foundation/Foundation.h>
#import "TortureObjc.h"

typedef enum {
    TModeA,
    TModeB,
} TMode;

@protocol TGreeter <NSObject>
@property (nonatomic, copy) NSString *name;
- (NSString *)greet;
@optional
+ (instancetype)shared;
@end

@interface TBase : NSObject
@property (nonatomic, strong) NSString *title;
- (void)prepare:(NSInteger)count with:(NSString *)label;
+ (instancetype)create;
@end

@interface TWidget : TBase <TGreeter>
@property (nonatomic, assign) BOOL enabled;
- (void)greet;
- (nullable TWidget *)maybe;
@end

@implementation TBase

+ (instancetype)create {
    return [[self alloc] init];
}

- (void)prepare:(NSInteger)count with:(NSString *)label {
    [self greet];
}

- (void)greet {
}

@end

@implementation TWidget

- (void)greet {
    [super greet];
    [self prepare:1 with:@"x"];
    SEL action = @selector(prepare:with:);
    (void)action;
}

- (nullable TWidget *)maybe {
    return nil;
}

@end

@implementation TWidget (Extras)

- (void)extra {
    TWidget *made = [TWidget create];
    [made greet];
}

@end

static void tortureHelper(void) {
    TWidget *widget = [TWidget create];
    [widget prepare:2 with:@"y"];
    [widget greet];
    [[TWidget create] greet];
}